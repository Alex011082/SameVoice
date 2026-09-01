#!/bin/bash
# Переключатель движка на сервере samevoice: облако <-> GPU-под.
# Запускается НА СЕРВЕРЕ. Меняет только четыре строки в /opt/samevoice/.env
# и перезапускает агента; бэкенд, веб и панель прослушки не трогаются.
#
#   engine-switch.sh pod <POD_ID>   — STT и перевод идут на под
#   engine-switch.sh cloud          — вернуть облако (deepgram+gemini)
#   engine-switch.sh status         — что стоит сейчас
#
# Порты пода 8102/8103 открыты в интернет без авторизации — режим pod
# включать только на время теста, под гасить сразу после.
set -e
ENV=/opt/samevoice/.env

setvar(){ grep -q "^$1=" "$ENV" && sed -i "s|^$1=.*|$1=$2|" "$ENV" || echo "$1=$2" >> "$ENV"; }

case "$1" in
  pod)
    [ -n "$2" ] || { echo "нужен POD_ID"; exit 1; }
    setvar STT_PROVIDER runpod
    setvar MT_PROVIDER runpod
    # Один порт, не три: под с тремя http-портами не запускает контейнер
    # вовсе (опыт 01.09, под vfa1ryl4zqdwvi ожил с одним). Сервисы
    # смонтированы в gpu/engine_app.py по путям /stt и /mt.
    setvar RUNPOD_STT_URL "wss://$2-8000.proxy.runpod.net/stt/v1/stream"
    setvar RUNPOD_MT_URL "https://$2-8000.proxy.runpod.net/mt/v1/translate"
    ;;
  cloud)
    setvar STT_PROVIDER deepgram
    setvar MT_PROVIDER gemini
    ;;
  status)
    grep -E "^(STT_PROVIDER|MT_PROVIDER|RUNPOD_STT_URL|RUNPOD_MT_URL)=" "$ENV"
    exit 0
    ;;
  *) echo "pod <id> | cloud | status"; exit 1 ;;
esac
systemctl restart samevoice-agent
sleep 2
systemctl is-active samevoice-agent
grep -E "^(STT_PROVIDER|MT_PROVIDER)=" "$ENV"
