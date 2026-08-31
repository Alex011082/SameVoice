"""LoRA-дообучение угадывателя (Qwen3) на диалогах фабрики v1.

Зачем: лестница recall без обучения упёрлась в 34.4% (RESULT.md, эксп. 6-7).
Дообучаем модель продолжать реплику в НАШЕМ формате промпта — тот же рендер,
что в gpu/predictor/app.py (PROMPT_STYLE=chat, continue_final_message).
Лосс считается только по токенам самой реплики; промпт замаскирован (-100).

Почему ручной цикл, а не transformers.Trainer: 31.08 смоук упал на
TrainingArguments (в transformers 5.x выпилены/переименованы аргументы вроде
warmup_ratio). Ручной цикл на AdamW + LambdaLR не зависит от сигнатур
Trainer и одинаково работает на любой версии transformers и на CPU/GPU.

Маска лосса через "full vs stub": рендерим чат-шаблон дважды — с реальной
репликой и с меткой-заглушкой. Общий префикс двух строк = промпт; токены
до его длины получают label=-100. Заглушка выбрана так, чтобы не
встречаться в шаблоне.

Смоук на CPU: --max-steps 5 --batch 2, затем боевой запуск на поде:
  python scripts/predictor-finetune.py --train train-v1.jsonl \
      --val val-v1.jsonl --out /workspace/ft --epochs 3 --batch 16
Выход: <out>/adapter — папка PEFT-адаптера; боевой app.py подхватывает её
через PREDICTOR_ADAPTER=<путь> (merge_and_unload при загрузке).
"""
import argparse
import json
import math
import time
from pathlib import Path

import torch
from torch.utils.data import DataLoader, Dataset

STUB = "⁉⁉SVSTUB⁉⁉"  # не встречается ни в шаблоне, ни в данных


def render_text(tokenizer, system: str, utterance: str) -> str:
    """Текст боевого промпта: system + незакрытый assistant-ход (как в app.py)."""
    messages = [
        {"role": "system", "content": system},
        {"role": "assistant", "content": utterance},
    ]
    try:
        return tokenizer.apply_chat_template(
            messages, tokenize=False, continue_final_message=True,
            add_generation_prompt=False, enable_thinking=False,
        )
    except TypeError:  # шаблон без enable_thinking
        return tokenizer.apply_chat_template(
            messages, tokenize=False, continue_final_message=True,
            add_generation_prompt=False,
        )


class DialogDataset(Dataset):
    def __init__(self, path: str, tokenizer, max_len: int) -> None:
        self.rows = [json.loads(l) for l in open(path)]
        self.tokenizer = tokenizer
        self.max_len = max_len

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, i: int) -> dict:
        row = self.rows[i]
        full = render_text(self.tokenizer, row["system"], row["utterance"])
        stub = render_text(self.tokenizer, row["system"], STUB)
        prompt_text = full[:stub.index(STUB)]
        assert full.startswith(prompt_text), "шаблон исказил промпт до реплики"
        prompt_len = len(self.tokenizer(prompt_text, add_special_tokens=False).input_ids)
        ids = self.tokenizer(full, add_special_tokens=False,
                             truncation=True, max_length=self.max_len).input_ids
        labels = list(ids)
        labels[:min(prompt_len, len(labels))] = [-100] * min(prompt_len, len(labels))
        return {"input_ids": ids, "labels": labels}


def collate(batch: list[dict], pad_id: int) -> dict:
    width = max(len(b["input_ids"]) for b in batch)
    ids, labels, mask = [], [], []
    for b in batch:
        pad = width - len(b["input_ids"])
        ids.append(b["input_ids"] + [pad_id] * pad)
        labels.append(b["labels"] + [-100] * pad)
        mask.append([1] * len(b["input_ids"]) + [0] * pad)
    return {
        "input_ids": torch.tensor(ids),
        "labels": torch.tensor(labels),
        "attention_mask": torch.tensor(mask),
    }


@torch.inference_mode()
def eval_loss(model, loader, device) -> float:
    model.eval()
    total, count = 0.0, 0
    for batch in loader:
        batch = {k: v.to(device) for k, v in batch.items()}
        out = model(**batch)
        n = int((batch["labels"] != -100).sum())
        total += float(out.loss) * n
        count += n
    model.train()
    return total / max(count, 1)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", required=True)
    ap.add_argument("--val", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="Qwen/Qwen3-0.6B")
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--warmup-steps", type=int, default=20)
    ap.add_argument("--max-len", type=int, default=512)
    ap.add_argument("--max-steps", type=int, default=0,
                    help="0 = без ограничения; >0 — смоук на N шагов")
    args = ap.parse_args()

    from peft import LoraConfig, get_peft_model
    from transformers import AutoModelForCausalLM, AutoTokenizer

    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.bfloat16 if device == "cuda" else torch.float32
    tokenizer = AutoTokenizer.from_pretrained(args.model)
    model = AutoModelForCausalLM.from_pretrained(args.model, dtype=dtype)
    model = model.to(device)

    lora = LoraConfig(
        r=16, lora_alpha=32, lora_dropout=0.05, bias="none",
        task_type="CAUSAL_LM",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                        "gate_proj", "up_proj", "down_proj"],
    )
    model = get_peft_model(model, lora)
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    print(f"устройство: {device} | обучаемых параметров: {trainable:,}")

    pad_id = tokenizer.pad_token_id or tokenizer.eos_token_id
    train_ds = DialogDataset(args.train, tokenizer, args.max_len)
    val_ds = DialogDataset(args.val, tokenizer, args.max_len)
    train_dl = DataLoader(train_ds, batch_size=args.batch, shuffle=True,
                          collate_fn=lambda b: collate(b, pad_id))
    val_dl = DataLoader(val_ds, batch_size=args.batch, shuffle=False,
                        collate_fn=lambda b: collate(b, pad_id))

    steps_total = args.max_steps or args.epochs * math.ceil(len(train_ds) / args.batch)
    optim = torch.optim.AdamW((p for p in model.parameters() if p.requires_grad),
                              lr=args.lr)
    sched = torch.optim.lr_scheduler.LambdaLR(
        optim, lambda s: min(1.0, (s + 1) / max(args.warmup_steps, 1)))

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    model.train()
    step, t0, best = 0, time.perf_counter(), float("inf")
    log = open(out_dir / "train-log.jsonl", "a")
    for epoch in range(args.epochs):
        for batch in train_dl:
            batch = {k: v.to(device) for k, v in batch.items()}
            out = model(**batch)
            out.loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optim.step()
            sched.step()
            optim.zero_grad()
            step += 1
            if step % 25 == 0 or step == steps_total:
                rec = {"step": step, "of": steps_total, "epoch": epoch,
                       "loss": round(float(out.loss), 4),
                       "sec": round(time.perf_counter() - t0, 1)}
                print(json.dumps(rec), flush=True)
                log.write(json.dumps(rec) + "\n")
                log.flush()
            if args.max_steps and step >= args.max_steps:
                break
        if args.max_steps and step >= args.max_steps:
            break
        vloss = eval_loss(model, val_dl, device)
        rec = {"epoch": epoch, "val_loss": round(vloss, 4)}
        print(json.dumps(rec), flush=True)
        log.write(json.dumps(rec) + "\n")
        log.flush()
        if vloss < best:
            best = vloss
            model.save_pretrained(out_dir / "adapter")
            print(f"адаптер сохранён (val_loss {vloss:.4f})", flush=True)

    if args.max_steps:  # смоук: сохранить, что есть, для проверки формата
        model.save_pretrained(out_dir / "adapter")
    print(f"готово: {out_dir/'adapter'} | шагов {step} | "
          f"{time.perf_counter() - t0:.0f} с", flush=True)


if __name__ == "__main__":
    main()
