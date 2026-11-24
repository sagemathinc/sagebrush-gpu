// Display words. The API always uses the generic ones; a project may choose its own
// ("course", "student", "instructor"), and every component gets its words from here.

import type { ProjectLabels } from "@sbgpu/api";

export const GENERIC_LABELS: Readonly<ProjectLabels> = Object.freeze({
  project: "project",
  member: "member",
  manager: "manager",
  assistant: "assistant",
  team: "team",
});

export type LabelKey = keyof ProjectLabels;

/** The project's labels, with the generic word for any that is missing or blank. */
export function resolveLabels(labels: Partial<ProjectLabels> | null | undefined): ProjectLabels {
  const out = { ...GENERIC_LABELS };
  if (labels == null) return out;
  for (const key of Object.keys(GENERIC_LABELS) as LabelKey[]) {
    const word = labels[key];
    if (typeof word === "string" && word.trim() !== "") out[key] = word.trim();
  }
  return out;
}

/** "student" -> "Student"; leaves acronyms ("TA") alone. */
export function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** English plural, good enough for role and unit words ("TA" -> "TAs", "class" -> "classes"). */
export function plural(word: string): string {
  if (/(s|x|z|ch|sh)$/i.test(word)) return word + "es";
  if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + "ies";
  return word + "s";
}

/** "a student", "an instructor", "a TA": by the first letter, good enough for role words. */
export function withArticle(word: string): string {
  return `${/^[aeiou]/i.test(word) ? "an" : "a"} ${word}`;
}
