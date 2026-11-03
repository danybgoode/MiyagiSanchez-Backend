import { readFileSync } from 'fs'
import { join } from 'path'
import yaml from 'js-yaml'

export type YamlOffense = {
  filePath: string
  message: string
}

// The deploy-critical canonical files — an explicit list, not a directory scan. `cloudbuild.yaml`
// (breaks the Cloud Build deploy pipeline if malformed), `.github/dependabot.yml` (breaks
// dependency-update automation silently) and `.github/workflows/dependabot-automerge.yml` (added
// 2026-08-24: it queues merges to main, and a merge to main deploys — so it is deploy-critical by the
// same definition, and a malformed workflow file is the silent kind of broken, since GitHub simply
// never runs it and reports nothing). Mirrors the frontend's identical guard
// (apps/storefront/lib/yaml-audit.ts) — same shape, independent copy (no shared-package mechanism
// exists across these two repos; see the epic's own retro for why duplication was the accepted call).
export const canonicalYamlFiles = [
  'cloudbuild.yaml',
  '.github/dependabot.yml',
  '.github/workflows/dependabot-automerge.yml',
]

export function findYamlParseOffenders(repoRoot: string, files: string[] = canonicalYamlFiles): YamlOffense[] {
  return findYamlParseOffendersInFiles(
    files.map((filePath) => ({
      filePath,
      content: readFileSync(join(repoRoot, filePath), 'utf8'),
    })),
  )
}

export function findYamlParseOffendersInFiles(files: { filePath: string; content: string }[]): YamlOffense[] {
  const offenders: YamlOffense[] = []

  for (const file of files) {
    try {
      yaml.load(file.content)
    } catch (err) {
      offenders.push({
        filePath: file.filePath,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return offenders
}

export function formatYamlOffense(offense: YamlOffense) {
  return `${offense.filePath}: ${offense.message}`
}
