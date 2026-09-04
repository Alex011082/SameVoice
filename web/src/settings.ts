/* Экран настроек: шестерёнка в шапке, лист поверх приложения.
 *
 * Здесь живёт всё «про меня и про телефон»: уведомления, вход без кода,
 * тема, имя и языки, выход. Раньше уведомления прятались в «лаборатории»
 * и были видны только с инженерным ключом — обычный человек физически не
 * мог их включить; из-за этого пуш «Соединяю» не доходил до основателя.
 *
 * Модуль ничего не знает о звонках: только профиль, браузерные разрешения
 * и оркестраторские подписки. Все запросы — обычные fetch, их несёт
 * sv-session.js (кука + токен устройства).
 */

import { api } from './api';
import { passkeysSupported, registerPasskey } from './passkeys';
import type { UserProfile } from './types';

declare global {
  interface Window {
    __svTheme?: { current: () => string; apply: (name: string) => void };
  }
}

let sheet: HTMLElement | null = null;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function row(title: string, hint: string): { box: HTMLElement; acts: HTMLElement } {
  const box = el('div', 'set-row');
  const head = el('div', 'set-row-main');
  head.append(el('b', undefined, title), el('span', 'set-hint', hint));
  const acts = el('div', 'set-acts');
  box.append(head, acts);
  return { box, acts };
}

/* ------------------------------ уведомления ------------------------------ */

async function pushState(): Promise<'on' | 'off' | 'denied' | 'unsupported'> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return 'unsupported';
  }
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration('/sv-push-sw.js');
  const sub = reg && (await reg.pushManager.getSubscription());
  return sub ? 'on' : 'off';
}

function b64ToBytes(b64: string): Uint8Array {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function enablePush(userId: string): Promise<void> {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('браузер не дал разрешения');
  const keyRes = await fetch('/orch/push/key', { credentials: 'include' });
  const { key } = (await keyRes.json()) as { key: string | null };
  if (!key) throw new Error('пуш на сервере не настроен');
  const reg = await navigator.serviceWorker.register('/sv-push-sw.js');
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64ToBytes(key).buffer as ArrayBuffer,
    });
  }
  const res = await fetch('/orch/push/subscribe', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, subscription: sub.toJSON() }),
  });
  if (!res.ok) throw new Error(`сервер отказал: ${res.status}`);
}

async function disablePush(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration('/sv-push-sw.js');
  const sub = reg && (await reg.pushManager.getSubscription());
  if (sub) await sub.unsubscribe();
}

function mountPushRow(user: UserProfile, host: HTMLElement): void {
  const { box, acts } = row('Уведомления', 'Пуш о звонках и напоминания о встречах.');
  const status = el('span', 'set-status');
  const btn = el('button', 'btn');
  btn.type = 'button';
  acts.append(status, btn);
  host.append(box);

  const paint = async (): Promise<void> => {
    const s = await pushState();
    btn.hidden = false;
    if (s === 'unsupported') {
      status.textContent = 'этот браузер не умеет';
      btn.hidden = true;
    } else if (s === 'denied') {
      status.textContent = 'запрещены в браузере';
      btn.textContent = 'Как разрешить';
      btn.onclick = () => {
        status.textContent =
          'iPhone: значок «аА» в адресной строке → Настройки сайта → Уведомления. Потом вернитесь сюда.';
      };
    } else if (s === 'on') {
      status.textContent = 'включены';
      btn.textContent = 'Отключить';
      btn.onclick = () => {
        void disablePush().then(paint);
      };
    } else {
      status.textContent = 'выключены';
      btn.textContent = 'Разрешить';
      btn.onclick = () => {
        btn.disabled = true;
        enablePush(user.id)
          .catch((err: unknown) => {
            status.textContent = `не вышло: ${err instanceof Error ? err.message : String(err)}`;
          })
          .finally(() => {
            btn.disabled = false;
            void paint();
          });
      };
    }
  };
  void paint();
}

/* ----------------------------- вход без кода ----------------------------- */

function mountPasskeyRow(host: HTMLElement): void {
  const { box, acts } = row('Вход без кода', 'Face ID или отпечаток вместо кода из SMS.');
  const status = el('span', 'set-status');
  const btn = el('button', 'btn', 'Включить на этом устройстве');
  btn.type = 'button';
  acts.append(status, btn);
  host.append(box);
  if (!passkeysSupported()) {
    status.textContent = 'этот браузер не умеет';
    btn.hidden = true;
    return;
  }
  const paint = async (): Promise<void> => {
    try {
      const res = await fetch('/api/auth/passkey', { credentials: 'include' });
      if (!res.ok) return;
      const mine = (await res.json()) as { count: number; devices: Array<{ label: string }> };
      status.textContent = mine.count
        ? `устройств с ключом: ${mine.count} (${mine.devices.map((d) => d.label).join(', ')})`
        : 'пока не включён';
    } catch {
      /* не критично */
    }
  };
  btn.onclick = () => {
    btn.disabled = true;
    registerPasskey()
      .then(() => {
        status.textContent = 'готово — в следующий раз просто Face ID';
      })
      .catch((err: unknown) => {
        status.textContent = `не вышло: ${err instanceof Error ? err.message : String(err)}`;
      })
      .finally(() => {
        btn.disabled = false;
        void paint();
      });
  };
  void paint();
}

/* --------------------------------- тема --------------------------------- */

function mountThemeRow(host: HTMLElement): void {
  const { box, acts } = row('Тема', 'Тишина — космос; ZGen — язык = цвет.');
  host.append(box);
  const mk = (name: string, label: string): HTMLButtonElement => {
    const b = el('button', 'btn btn-ghost set-theme', label);
    b.type = 'button';
    const paint = (): void => {
      const cur = window.__svTheme?.current() ?? 'тишина';
      b.classList.toggle('set-theme-on', cur === name);
    };
    b.onclick = () => {
      window.__svTheme?.apply(name);
      for (const sib of acts.querySelectorAll('button')) sib.classList.remove('set-theme-on');
      b.classList.add('set-theme-on');
    };
    paint();
    return b;
  };
  acts.append(mk('тишина', 'Тишина'), mk('zgen', 'ZGen'));
}

/* -------------------------------- профиль -------------------------------- */

function mountProfileRows(user: UserProfile, host: HTMLElement, onSaved: () => void): void {
  const { box, acts } = row('Профиль', 'Имя видит собеседник; язык решает, куда переводить.');
  box.classList.add('set-profile');
  const name = el('input');
  name.type = 'text';
  name.maxLength = 64;
  name.value = user.displayName;
  name.setAttribute('aria-label', 'Имя');
  const lang = el('select');
  lang.innerHTML = '<option value="ru">Русский</option><option value="he">עברית</option>';
  lang.value = user.lang;
  lang.setAttribute('aria-label', 'Язык');
  const gender = el('select');
  gender.innerHTML =
    '<option value="m">Мужской голос</option><option value="f">Женский голос</option><option value="u">Голос не важен</option>';
  gender.value = user.gender ?? 'u';
  gender.setAttribute('aria-label', 'Голос');
  const save = el('button', 'btn', 'Сохранить');
  save.type = 'button';
  const status = el('span', 'set-status');
  save.onclick = () => {
    save.disabled = true;
    api
      .updateUser(user.id, {
        displayName: name.value.trim() || user.displayName,
        lang: lang.value as 'ru' | 'he',
        gender: gender.value as 'm' | 'f' | 'u',
      })
      .then(() => {
        status.textContent = 'сохранено';
        onSaved();
      })
      .catch((err: unknown) => {
        status.textContent = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        save.disabled = false;
      });
  };
  acts.append(name, lang, gender, save, status);
  host.append(box);
}

/* --------------------------------- выход --------------------------------- */

function mountLogoutRow(host: HTMLElement): void {
  const { box, acts } = row('Выход', 'На этом устройстве понадобится войти заново.');
  const btn = el('button', 'btn btn-danger', 'Выйти');
  btn.type = 'button';
  btn.onclick = () => {
    void fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).finally(() => {
      try {
        localStorage.removeItem('sv-session-token');
      } catch {
        /* пусто */
      }
      window.location.reload();
    });
  };
  acts.append(btn);
  host.append(box);
}

/* --------------------------------- лист --------------------------------- */

function openSheet(user: UserProfile, onProfileSaved: () => void): void {
  if (sheet) sheet.remove();
  sheet = el('div', 'sv-sheet set-sheet');
  const card = el('div', 'sv-sheet-card');
  card.append(el('h2', undefined, 'настройки.'));
  const sub = el('p', 'sv-sub', `${user.displayName} · ${user.lang === 'he' ? 'עברית' : 'русский'}`);
  card.append(sub);
  mountPushRow(user, card);
  mountPasskeyRow(card);
  mountThemeRow(card);
  mountProfileRows(user, card, onProfileSaved);
  mountLogoutRow(card);
  const close = el('button', 'btn btn-ghost set-close', 'Закрыть');
  close.type = 'button';
  close.onclick = () => {
    sheet?.remove();
    sheet = null;
  };
  card.append(close);
  sheet.append(card);
  sheet.addEventListener('click', (ev) => {
    if (ev.target === sheet) {
      sheet?.remove();
      sheet = null;
    }
  });
  document.body.append(sheet);
}

/** Шестерёнка в шапке. Появляется после входа, живёт рядом с темой. */
export function mountSettingsButton(user: UserProfile, onProfileSaved: () => void): void {
  const bar = document.getElementById('topbar');
  if (!bar || document.getElementById('sv-settings-btn')) return;
  const btn = el('button', undefined, '⚙︎');
  btn.id = 'sv-settings-btn';
  btn.type = 'button';
  btn.title = 'Настройки';
  btn.setAttribute('aria-label', 'Настройки');
  btn.addEventListener('click', () => openSheet(user, onProfileSaved));
  const themeBtn = document.getElementById('sv-theme-btn');
  if (themeBtn) bar.insertBefore(btn, themeBtn);
  else bar.appendChild(btn);
}
