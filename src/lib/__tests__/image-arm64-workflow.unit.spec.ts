import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * miyagi-to-oracle-vm S1.2 — the arm64 image the Oracle VM pulls must be the SAME build as the Cloud Run
 * image: this repo's Dockerfile, this repo's root as context, no build args (cloudbuild.yaml passes none).
 * It is built on a native arm64 runner and pushed by commit sha, so the VM can pin it and roll back by
 * restarting rather than rebuilding on a 2-core box shared with another product.
 *
 * Plain string checks on the YAML, same shape as cloudbuild-cache.unit.spec.ts.
 */

const ROOT = process.cwd()
const workflow = readFileSync(join(ROOT, '.github/workflows/image-arm64.yml'), 'utf8')
const cloudbuild = readFileSync(join(ROOT, 'cloudbuild.yaml'), 'utf8')
const steps = workflow.slice(workflow.indexOf('jobs:'))
// The header comment of cloudbuild.yaml quotes a rejected `--build-arg` in prose; assert on its steps only.
const cbSteps = cloudbuild.slice(cloudbuild.indexOf('\nsteps:'))

describe('image-arm64.yml', () => {
  it('builds on a native arm64 runner, for arm64 only', () => {
    expect(steps).toMatch(/runs-on: ubuntu-24\.04-arm/)
    expect(steps).toMatch(/platforms: linux\/arm64$/m)
  })

  it('builds the repo root with the default Dockerfile, like cloudbuild.yaml', () => {
    expect(steps).toMatch(/context: \.$/m)
    expect(steps).not.toMatch(/^\s+file:/m)
    expect(cbSteps).toMatch(/^\s+- \.$/m)
  })

  it('passes no build args, because cloudbuild.yaml passes none', () => {
    expect(cbSteps).not.toMatch(/--build-arg/)
    expect(steps).not.toMatch(/build-args:/)
  })

  it('pushes an immutable per-commit tag the VM can pin', () => {
    expect(steps).toMatch(/ghcr\.io\/danybgoode\/miyagisanchez-backend:\$\{\{ github\.sha \}\}/)
  })

  it('deploys nothing — Cloud Build owns Cloud Run until the cutover', () => {
    expect(steps).not.toMatch(/gcloud|ssh |kubectl/)
  })
})
