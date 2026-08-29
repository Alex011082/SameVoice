/**
 * Reading and patching a dotenv file, with one rule above all others:
 * **a secret value never leaves this module.**
 *
 * The panel shows which keys are configured and lets you set them. It must never
 * be able to READ one back out, because the panel is a web page: anything it can
 * fetch, a stray browser extension or a mis-clicked screen share can also see.
 * `describeEnv` therefore returns presence and a masked tail, never the value.
 *
 * The same reasoning is why the panel server binds to 127.0.0.1 only. These two
 * decisions are load-bearing together — relaxing either one turns a dev tool
 * into a credential endpoint.
 */

import { readFile, writeFile } from "node:fs/promises";

/** Keys whose values are secret. Anything matching is masked, never returned. */
const SECRET_RE = /(KEY|SECRET|TOKEN|PASSWORD)$/i;

export function isSecretName(name) {
  return SECRET_RE.test(String(name));
}

export function parseEnv(text) {
  const out = new Map();
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    out.set(line.slice(0, eq).trim(), line.slice(eq + 1));
  }
  return out;
}

/** Last four characters, so a key can be told apart from another without exposing it. */
export function maskValue(value) {
  const v = String(value ?? "");
  if (!v) return "";
  if (v.length <= 4) return "•".repeat(v.length);
  return `••••${v.slice(-4)}`;
}

/**
 * What the browser is allowed to know about the environment: names, whether
 * they are set, and a masked tail for secrets. Non-secret values (provider
 * choice, model, URL) are returned in full — they are configuration, not
 * credentials, and seeing them is the point of the panel.
 */
export function describeEnv(text, interesting) {
  const parsed = parseEnv(text);
  const names = interesting ?? [...parsed.keys()];
  return names.map(name => {
    const raw = parsed.get(name);
    const set = raw !== undefined && String(raw).trim() !== "";
    const secret = isSecretName(name);
    return {
      name,
      set,
      secret,
      value: secret ? undefined : set ? raw : "",
      masked: secret && set ? maskValue(raw) : "",
    };
  });
}

/**
 * Set or replace keys in dotenv text, preserving comments, ordering and any
 * key the patch does not mention. A key that is absent is appended rather than
 * silently dropped, because a panel that "saved" a key into nowhere is worse
 * than one that refuses.
 */
export function patchEnvText(text, patch) {
  let out = String(text ?? "");
  const trailingNewline = out.endsWith("\n") || out === "";
  const appended = [];

  for (const [name, value] of Object.entries(patch)) {
    if (!/^[A-Z][A-Z\d_]*$/.test(name)) {
      throw new Error(`Недопустимое имя переменной: ${name}`);
    }
    const safe = String(value ?? "").replace(/[\r\n]/g, "");
    const re = new RegExp(`^${name}=.*$`, "m");
    if (re.test(out)) {
      out = out.replace(re, `${name}=${safe}`);
    } else {
      appended.push(`${name}=${safe}`);
    }
  }

  if (appended.length) {
    if (!trailingNewline) out += "\n";
    out += `${appended.join("\n")}\n`;
  }
  return out;
}

export async function readEnvFile(path) {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return "";
    throw err;
  }
}

export async function writeEnvFile(path, text) {
  // 0600: the file holds live provider credentials.
  await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
}
