"""Создание пода RunPod для схемы БЕЗ SSH.

Под получает dockerArgs, которые скачивают bootstrap с нашего сервера и
исполняют его; наружу торчит только HTTP-порт 8000 с логом и результатами
(https://<pod>-8000.proxy.runpod.net/). Заход внутрь не предусмотрен вовсе —
отладка идёт через канал патчей (см. scripts/runpod-bootstrap.sh).

Уроки 31.08.2026, вшитые сюда:
 - запрос строит json.dumps, а не bash-склейка (четыре уровня кавычек);
 - шлёт curl: urllib с User-Agent "Python-urllib" получает от RunPod 403;
 - образ runpod/pytorch, а не runpod/base: на base pip-torch не видел CUDA;
 - dockerArgs подменяет штатный старт образа — sshd не будет, и не нужен.

Использование:
    RUNPOD_API_KEY=... python3 scripts/_runpod_create_nossh.py <rd-токен>
Печатает id пода. Токен — имя каталога rd-<hex> на samevoice.0110.digital,
куда runpod-nossh-launch.sh выложил bootstrap.sh и payload.tgz.
"""
import json
import os
import subprocess
import sys

key = os.environ.get("RUNPOD_API_KEY") or sys.exit("нет RUNPOD_API_KEY в окружении")
token = sys.argv[1] if len(sys.argv) > 1 else sys.exit("нет rd-токена в argv")
url = f"https://samevoice.0110.digital/{token}/bootstrap.sh"
cmd = f"bash -c 'curl -fsSL {url} -o /tmp/b.sh || wget -qO /tmp/b.sh {url}; bash /tmp/b.sh'"

mutation = """
mutation ($input: PodFindAndDeployOnDemandInput) {
  podFindAndDeployOnDemand(input: $input) { id }
}
"""
variables = {"input": {
    "cloudType": "ALL", "gpuCount": 1, "volumeInGb": 0, "containerDiskInGb": 80,
    "minMemoryInGb": 24, "minVcpuCount": 8,
    "gpuTypeId": "NVIDIA GeForce RTX 4090",
    "name": f"samevoice-nossh-{token[-6:]}",
    "imageName": "runpod/pytorch:2.8.0-py3.11-cuda12.8.1-cudnn-devel-ubuntu22.04",
    "ports": "8000/http",
    "dockerArgs": cmd,
    "env": [{"key": "HF_HOME", "value": "/workspace/hf"}],
}}
payload = json.dumps({"query": mutation, "variables": variables})
proc = subprocess.run(
    ["curl", "-sS", "--max-time", "60", "-X", "POST", "https://api.runpod.io/graphql",
     "-H", "Content-Type: application/json", "-H", f"Authorization: Bearer {key}",
     "--data-binary", "@-"],
    input=payload, capture_output=True, text=True)
if proc.returncode != 0:
    sys.exit("сеть: " + proc.stderr.strip()[:200])
body = json.loads(proc.stdout)
if body.get("errors"):
    sys.exit("ОШИБКА: " + body["errors"][0].get("message", "?"))
pod = (body.get("data") or {}).get("podFindAndDeployOnDemand")
if not pod:
    sys.exit("под не вернулся: " + json.dumps(body)[:300])
print(pod["id"])
