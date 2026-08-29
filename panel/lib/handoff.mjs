/**
 * HANDOFF parsing and the two copy outputs, as pure functions.
 *
 * Lifted from the Jarvis roadmap panel (`~/Jarvis/docs/roadmap/roadmap.js`) and
 * narrowed to what SameVoice actually needs. Kept pure and in its own module for
 * one reason: these two formatters are the whole point of the right-hand panel,
 * and a formatter that silently drops a field produces a handoff that looks
 * complete and is not. Tested directly in panel/test/panel.test.mjs.
 *
 * The vocabulary (цель / шаги / готово, когда) matches the Jarvis panel on
 * purpose: this project is destined to become part of the 0110 switchboard, and
 * a task copied out of either panel should read the same to whoever receives it.
 */

/** Fields a task must carry before it can be turned into a handoff. */
const REQUIRED = ["id", "title", "goal"];

export function validateTask(task) {
  const problems = [];
  for (const field of REQUIRED) {
    if (!task || !String(task[field] ?? "").trim()) problems.push(field);
  }
  return problems;
}

function bulletLines(items, ordered = false) {
  const list = Array.isArray(items) ? items.filter(x => String(x ?? "").trim()) : [];
  if (!list.length) return "—";
  return list.map((x, i) => (ordered ? `${i + 1}. ${x}` : `- ${x}`)).join("\n");
}

/** Drops blank lines that would otherwise double up where a section is absent. */
function tidy(lines) {
  return lines
    .filter((line, i, all) => line !== "" || (i > 0 && all[i - 1] !== ""))
    .join("\n")
    .trim();
}

/**
 * A standalone Markdown handoff. Must be readable by someone who has never
 * opened the panel — that is the acceptance test for this function.
 */
export function formatTaskHandoff(task) {
  return tidy([
    `# ${task.title}`,
    "",
    `**Цель:** ${task.goal}`,
    task.status ? `**Состояние:** ${task.status}` : "",
    task.effort ? `**Трудоёмкость:** ${task.effort}` : "",
    task.decision ? `**Открытое решение:** ${task.decision}` : "",
    "",
    "## Шаги",
    bulletLines(task.steps, true),
    "",
    "## Проверка",
    task.verification ? task.verification : "—",
    "",
    "## Готово, когда",
    bulletLines(task.done),
    "",
    task.dependencies?.length ? `**Зависимости:** ${task.dependencies.join(", ")}` : "",
    task.source ? `**Источник:** ${task.source}` : "",
  ]);
}

/**
 * The first prompt for an AI executor, built from the same task.
 *
 * The closing constraint is not decoration. This project has already been bitten
 * by it: a green test suite was read as a working call, twice, while the actual
 * two-person call failed for unrelated reasons. Passing tests are not proof that
 * anything works in production.
 */
export function formatTaskPrompt(task, context = {}) {
  const project = context.project ?? "SameVoice (0110)";
  const source = task.source ? `\n\nСначала прочитай и сверься с источником: ${task.source}. Поздние решения важнее ранних заметок.` : "";
  const decision = task.decision
    ? `\n\nОткрытое решение, которое нельзя молча принять за владельца: ${task.decision}`
    : "";
  const deps = task.dependencies?.length ? `\n\nЗависимости: ${task.dependencies.join(", ")}` : "";

  return tidy([
    `Ты работаешь над проектом ${project} — мессенджер с переводом голоса в реальном времени RU↔HE.`,
    `Репозиторий: ${context.repo ?? "/Users/davidov/SpeakEasy"}. Сводная спецификация: docs/07-product-spec.md — прочитай её первой.${source}`,
    "",
    `Задача: ${task.title}`,
    `Цель: ${task.goal}${decision}${deps}`,
    "",
    "Обязательная последовательность:",
    bulletLines(task.steps, true),
    "",
    "Проверка:",
    task.verification ? task.verification : "—",
    "",
    "Готово, когда:",
    bulletLines(task.done),
    "",
    "Ограничения:",
    "- Секреты не коммитить. Перед коммитом проверить staged diff на ключи.",
    "- Перед правкой файла — grep по вызывающим и по тестам, которые его сторожат; править обе стороны одним заходом.",
    "- `npm run smoke` должен быть зелёным перед коммитом.",
    "- Не выдавать пройденные тесты или сборку за доказательство работы в проде. Зелёный CI и работающий звонок — разные утверждения; если live-проверки не было, так и сказать.",
  ]);
}

/**
 * Repo-relative `.md` path, or throw. Guards the docs endpoint against reading
 * anything outside the repository.
 */
export function normalizeRepoMarkdownPath(input) {
  const value = String(input || "").trim().replace(/^\.\//, "");
  if (!value || value.startsWith("/") || value.includes("?") || value.includes("#")) {
    throw new Error("Нужен относительный путь к .md без query и fragment.");
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.split("/").includes("..") || !/\.md$/i.test(value)) {
    throw new Error("Разрешён только безопасный относительный путь к .md внутри репозитория.");
  }
  return value;
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z\dЀ-ӿ]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "task";
}

/**
 * Split a Markdown document into candidate tasks, one per `##` heading.
 *
 * Deliberately forgiving: a handoff written by a human will not follow a schema,
 * so anything recognisable becomes a field and everything else becomes a step.
 * The UI shows every candidate for editing before it is accepted, so a wrong
 * guess here costs a click, not a bad task.
 */
export function parseHandoffMarkdown(markdown, source = "HANDOFF.md") {
  const text = String(markdown ?? "");
  if (!text.trim()) return [];

  const lines = text.split(/\r?\n/);
  const sections = [];
  let current = null;

  for (const line of lines) {
    const heading = /^(#{2,3})\s+(.*\S)\s*$/.exec(line);
    if (heading) {
      if (current) sections.push(current);
      current = { title: heading[2].trim(), body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) sections.push(current);

  return sections.map((section, index) => {
    const body = section.body;
    const steps = [];
    const done = [];
    let goal = "";
    let verification = "";
    let bucket = "steps";

    for (const raw of body) {
      const line = raw.trim();
      if (!line) continue;

      const labelled = /^\*{0,2}(цель|goal|проверка|verification|готово,?\s*когда|done)\*{0,2}\s*[:—-]\s*(.*)$/i.exec(line);
      if (labelled) {
        const key = labelled[1].toLowerCase();
        const value = labelled[2].trim();
        if (/цель|goal/.test(key)) { goal ||= value; bucket = "steps"; continue; }
        if (/проверка|verification/.test(key)) { verification ||= value; bucket = "steps"; continue; }
        bucket = "done";
        if (value) done.push(value);
        continue;
      }
      if (/^\*{0,2}(готово|done)/i.test(line)) { bucket = "done"; continue; }
      if (/^\*{0,2}(шаг|план|steps?)/i.test(line)) { bucket = "steps"; continue; }

      const bullet = /^(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/.exec(line);
      const value = bullet ? bullet[1].trim() : line;
      if (bullet) {
        (bucket === "done" ? done : steps).push(value);
      } else if (!goal) {
        goal = value;
      } else if (bucket === "steps") {
        steps.push(value);
      }
    }

    return {
      id: `${slug(section.title)}-${index + 1}`,
      title: section.title,
      goal: goal || section.title,
      steps,
      done,
      verification,
      dependencies: [],
      source,
      imported: true,
    };
  }).filter(task => task.title);
}
