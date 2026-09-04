/* Как в приложении появляется новый живой собеседник.
 *
 * Раньше это делалось само и неправильно: каждый зарегистрировавшийся
 * становился контактом всем остальным, и в списке появлялся посторонний
 * человек, который мог позвонить. Знакомство должно быть осознанным, поэтому
 * здесь ровно три двери:
 *
 *   1. по номеру — если человек уже в SameVoice, пара связывается в обе
 *      стороны (сервер отвечает одинаково и на найденный номер, и на чужой:
 *      иначе маршрут стал бы способом проверять, кто здесь зарегистрирован);
 *   2. пригласить — ссылка уходит в WhatsApp или СМС через родное окно
 *      «Поделиться»; на iPhone это единственный способ, и он работает;
 *   3. из телефонной книги — там, где браузер это умеет. Safari на iPhone
 *      не умеет вовсе (Apple не даёт), поэтому кнопка появляется только на
 *      Android; обещать её всем было бы враньём.
 */

import { api } from './api';

const INVITE_TEXT = 'Поговорим в SameVoice? Мы будем говорить каждый на своём языке и понимать друг друга:';

interface ContactsManagerLike {
  select(
    props: string[],
    opts?: { multiple?: boolean },
  ): Promise<Array<{ tel?: string[]; name?: string[] }>>;
}

function addressBookApi(): ContactsManagerLike | null {
  const nav = navigator as Navigator & { contacts?: ContactsManagerLike };
  if (!nav.contacts || !('ContactsManager' in window)) return null;
  return nav.contacts;
}

/**
 * Персональная ссылка-приглашение: сервер выпускает её тому, кто вошёл, на
 * одно открытие и на семь дней. Открыл адресат — ссылка погасла; переслали
 * дальше — «уже использовано». Общего ключа в приложении больше нет.
 * Не вышло выпустить — отдаём голый адрес: человек хотя бы найдёт приложение.
 */
async function inviteUrl(): Promise<string> {
  try {
    const res = await fetch('/orch/invite', { method: 'POST', credentials: 'include' });
    if (res.ok) {
      const body = (await res.json()) as { url?: string };
      if (body.url) return body.url;
    }
  } catch {
    // сеть подвела — не повод молчать вовсе
  }
  return `${window.location.origin}/`;
}

async function share(text: string): Promise<{ how: 'shared' | 'copied' | 'failed'; url: string }> {
  const url = await inviteUrl();
  const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
  if (typeof nav.share === 'function') {
    try {
      await nav.share({ text, url });
      return { how: 'shared', url };
    } catch {
      // отказ в системном окне — не ошибка, просто продолжаем
    }
  }
  try {
    await navigator.clipboard.writeText(`${text} ${url}`);
    return { how: 'copied', url };
  } catch {
    return { how: 'failed', url };
  }
}

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

/**
 * Панель под списком контактов. Перерисовывается вместе со списком, поэтому
 * собирается заново — и по той же причине не хранит состояния между вызовами.
 */
export function renderAddContact(host: HTMLElement, onAdded: () => void): void {
  const box = el('div', 'addbox');

  const title = el('p', 'addbox-title', 'новый собеседник');
  const status = el('p', 'addbox-status');
  status.setAttribute('role', 'status');

  const form = el('form', 'addbox-row');
  const input = el('input');
  input.type = 'tel';
  input.inputMode = 'tel';
  input.autocomplete = 'tel';
  input.placeholder = '050 123 4567';
  input.setAttribute('aria-label', 'Номер телефона собеседника');
  const submit = el('button', 'btn', 'Добавить');
  submit.type = 'submit';
  form.append(input, submit);

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const phone = input.value.trim();
    if (!phone) return;
    submit.disabled = true;
    status.textContent = 'Проверяю…';
    api
      .addContactByPhone(phone)
      .then(() => {
        input.value = '';
        // Сервер намеренно не говорит, нашёлся ли номер, и экран не выдумывает
        // того, чего ему не сказали: он говорит, что будет дальше.
        status.textContent =
          'Готово. Если этот номер есть в SameVoice, человек появится в списке — обновите экран. Если нет — пригласите его кнопкой ниже.';
        onAdded();
      })
      .catch((err: unknown) => {
        status.textContent = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        submit.disabled = false;
      });
  });

  const acts = el('div', 'addbox-acts');

  const invite = el('button', 'btn btn-ghost', 'Пригласить в SameVoice');
  invite.type = 'button';
  invite.addEventListener('click', () => {
    void share(INVITE_TEXT).then(({ how, url }) => {
      status.textContent =
        how === 'shared'
          ? 'Приглашение отправлено.'
          : how === 'copied'
            ? 'Ссылка скопирована — вставьте её в переписку.'
            : `Ссылка: ${url}`;
    });
  });
  acts.append(invite);

  // Телефонная книга — только там, где браузер её отдаёт. На iPhone такого API
  // нет вовсе, и кнопки тоже не будет: неработающая кнопка хуже её отсутствия.
  const book = addressBookApi();
  if (book) {
    const sync = el('button', 'btn btn-ghost', 'Из телефонной книги');
    sync.type = 'button';
    sync.addEventListener('click', () => {
      sync.disabled = true;
      status.textContent = 'Выберите, кого проверить…';
      book
        .select(['tel'], { multiple: true })
        .then(async (picked) => {
          const phones = picked.flatMap((c) => c.tel ?? []).slice(0, 20);
          if (phones.length === 0) {
            status.textContent = 'Никто не выбран.';
            return;
          }
          let asked = 0;
          for (const phone of phones) {
            try {
              await api.addContactByPhone(phone);
              asked += 1;
            } catch {
              // один плохой номер не должен останавливать остальные
            }
          }
          status.textContent = `Проверено номеров: ${asked}. Кто из них в SameVoice — появится в списке.`;
          onAdded();
        })
        .catch(() => {
          status.textContent = 'Доступ к книге не дан.';
        })
        .finally(() => {
          sync.disabled = false;
        });
    });
    acts.append(sync);
  }

  box.append(title, form, acts, status);
  host.append(box);
}
