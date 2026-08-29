/**
 * The panel's pure parts. Two things are worth testing here and they are both
 * about not lying:
 *   - a handoff or prompt that silently drops a field looks complete and is not;
 *   - `describeEnv` must never hand a secret value back to the browser.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseHandoffMarkdown,
  formatTaskHandoff,
  formatTaskPrompt,
  normalizeRepoMarkdownPath,
  validateTask,
} from "../lib/handoff.mjs";

import { describeEnv, patchEnvText, parseEnv, maskValue, isSecretName } from "../lib/env.mjs";

// ------------------------------------------------------------------ parsing

const SAMPLE = `# Документ

## Починить протухание звонков
Цель: звонок не может висеть живым 15 часов.
- добавить таймаут в store.ts
- выселять завершённые звонки
Проверка: npm run smoke
Готово, когда:
- простаивающий звонок не joinable
- тест на выселение зелёный

## Логировать confidence
Цель: отличать «сомневался» от «уверенно ошибся».
- пробросить confidence из Deepgram
`;

test("разбирает документ по заголовкам ## в отдельные задачи", () => {
  const tasks = parseHandoffMarkdown(SAMPLE, "docs/x.md");
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].title, "Починить протухание звонков");
  assert.equal(tasks[0].goal, "звонок не может висеть живым 15 часов.");
  assert.deepEqual(tasks[0].steps, ["добавить таймаут в store.ts", "выселять завершённые звонки"]);
  assert.deepEqual(tasks[0].done, ["простаивающий звонок не joinable", "тест на выселение зелёный"]);
  assert.equal(tasks[0].verification, "npm run smoke");
  assert.equal(tasks[0].source, "docs/x.md");
});

test("пустой документ не даёт задач, а не одну пустую", () => {
  assert.deepEqual(parseHandoffMarkdown("", "x.md"), []);
  assert.deepEqual(parseHandoffMarkdown("   \n\n", "x.md"), []);
});

test("задача без заголовков ## не выдумывается", () => {
  assert.deepEqual(parseHandoffMarkdown("# Только H1\n\nтекст", "x.md"), []);
});

test("идентификаторы задач различаются даже при одинаковых заголовках", () => {
  const tasks = parseHandoffMarkdown("## Одно\nЦель: а\n\n## Одно\nЦель: б", "x.md");
  assert.equal(tasks.length, 2);
  assert.notEqual(tasks[0].id, tasks[1].id);
});

// ----------------------------------------------------------------- handoff

test("HANDOFF содержит все поля задачи и читается без панели", () => {
  const [task] = parseHandoffMarkdown(SAMPLE, "docs/x.md");
  const out = formatTaskHandoff(task);
  assert.match(out, /# Починить протухание звонков/);
  assert.match(out, /\*\*Цель:\*\* звонок не может висеть живым 15 часов\./);
  assert.match(out, /1\. добавить таймаут в store\.ts/);
  assert.match(out, /- простаивающий звонок не joinable/);
  assert.match(out, /npm run smoke/);
  assert.match(out, /docs\/x\.md/);
});

test("отсутствующие секции не оставляют пустых заголовков без содержимого", () => {
  const out = formatTaskHandoff({ id: "a", title: "T", goal: "G", steps: [], done: [] });
  assert.match(out, /## Шаги\n—/);
  assert.match(out, /## Готово, когда\n—/);
  assert.doesNotMatch(out, /\n\n\n/);
});

// ------------------------------------------------------------------ prompt

test("промт несёт задачу, шаги и критерии готовности", () => {
  const [task] = parseHandoffMarkdown(SAMPLE, "docs/x.md");
  const out = formatTaskPrompt(task, { repo: "/repo" });
  assert.match(out, /SameVoice/);
  assert.match(out, /docs\/07-product-spec\.md/);
  assert.match(out, /Задача: Починить протухание звонков/);
  assert.match(out, /1\. добавить таймаут/);
  assert.match(out, /Готово, когда:/);
});

test("промт запрещает выдавать зелёные тесты за доказательство работы в проде", () => {
  const [task] = parseHandoffMarkdown(SAMPLE, "docs/x.md");
  const out = formatTaskPrompt(task, {});
  assert.match(out, /не выдавать пройденные тесты|Не выдавать пройденные тесты/i);
  assert.match(out, /live/i);
});

test("открытое решение попадает в промт явно, а не молча принимается", () => {
  const out = formatTaskPrompt({
    id: "a", title: "T", goal: "G", steps: ["s"], done: ["d"],
    decision: "выбрать вендора",
  }, {});
  assert.match(out, /выбрать вендора/);
});

test("validateTask называет недостающие поля", () => {
  assert.deepEqual(validateTask({ id: "a", title: "", goal: "g" }), ["title"]);
  assert.deepEqual(validateTask({}), ["id", "title", "goal"]);
  assert.deepEqual(validateTask({ id: "a", title: "t", goal: "g" }), []);
});

// -------------------------------------------------------------- safe paths

test("путь к документу не выходит за пределы репозитория", () => {
  assert.equal(normalizeRepoMarkdownPath("docs/a.md"), "docs/a.md");
  assert.equal(normalizeRepoMarkdownPath("./docs/a.md"), "docs/a.md");
  for (const bad of ["/etc/passwd.md", "../secrets.md", "docs/../../x.md", "http://x/a.md", "docs/a.txt", ""]) {
    assert.throws(() => normalizeRepoMarkdownPath(bad), undefined, `должен отклонить: ${bad}`);
  }
});

// ---------------------------------------------------------------------- env

test("describeEnv никогда не возвращает значение секрета", () => {
  const text = "DEEPGRAM_API_KEY=supersecret1234\nSTT_PROVIDER=deepgram\n";
  const described = describeEnv(text, ["DEEPGRAM_API_KEY", "STT_PROVIDER"]);
  const key = described.find(x => x.name === "DEEPGRAM_API_KEY");
  assert.equal(key.set, true);
  assert.equal(key.secret, true);
  assert.equal(key.value, undefined, "значение секрета не должно уходить в браузер");
  assert.equal(key.masked, "••••1234");
  assert.doesNotMatch(JSON.stringify(described), /supersecret/);

  // Non-secret configuration IS returned: seeing it is the point of the panel.
  const provider = described.find(x => x.name === "STT_PROVIDER");
  assert.equal(provider.value, "deepgram");
});

test("незаданный ключ отражается как пустой, а не как отсутствующий", () => {
  const described = describeEnv("STT_PROVIDER=mock\n", ["CARTESIA_API_KEY"]);
  assert.equal(described[0].name, "CARTESIA_API_KEY");
  assert.equal(described[0].set, false);
  assert.equal(described[0].masked, "");
});

test("isSecretName ловит ключи, токены и секреты", () => {
  for (const n of ["OPENAI_API_KEY", "AGENT_SHARED_SECRET", "SOME_TOKEN", "DB_PASSWORD"]) {
    assert.equal(isSecretName(n), true, n);
  }
  for (const n of ["STT_PROVIDER", "OPENAI_MODEL", "LIVEKIT_URL"]) {
    assert.equal(isSecretName(n), false, n);
  }
});

test("maskValue не раскрывает короткие значения", () => {
  assert.equal(maskValue("abcd"), "••••");
  assert.equal(maskValue("abcdefgh"), "••••efgh");
  assert.equal(maskValue(""), "");
});

test("patchEnvText заменяет существующий ключ и сохраняет остальное", () => {
  const before = "# комментарий\nSTT_PROVIDER=mock\nOTHER=keep\n";
  const after = patchEnvText(before, { STT_PROVIDER: "deepgram" });
  assert.match(after, /^# комментарий$/m);
  assert.match(after, /^STT_PROVIDER=deepgram$/m);
  assert.match(after, /^OTHER=keep$/m);
  assert.equal(parseEnv(after).size, 2);
});

test("отсутствующий ключ дописывается, а не теряется", () => {
  const after = patchEnvText("A=1\n", { NEW_KEY: "v" });
  assert.match(after, /^NEW_KEY=v$/m);
  assert.match(after, /^A=1$/m);
});

test("перевод строки в значении не может подделать вторую переменную", () => {
  const after = patchEnvText("A=1\n", { A: "x\nEVIL=1" });
  assert.equal(parseEnv(after).get("A"), "xEVIL=1");
  assert.equal(parseEnv(after).has("EVIL"), false);
});

test("недопустимое имя переменной отклоняется", () => {
  assert.throws(() => patchEnvText("", { "bad name": "v" }));
  assert.throws(() => patchEnvText("", { "lowercase": "v" }));
});
