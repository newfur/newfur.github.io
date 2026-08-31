import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..', '..');
const workflowDir = path.join(rootDir, '.github', 'workflows');

/** Read all workflow YAML files */
function loadWorkflows() {
  const files = fs.readdirSync(workflowDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
  return files.map(f => ({
    name: f,
    path: path.join(workflowDir, f),
    content: fs.readFileSync(path.join(workflowDir, f), 'utf8'),
  }));
}

describe('Workflow policy enforcement', () => {
  let workflows;

  it('workflow directory exists and has files', () => {
    assert.ok(fs.existsSync(workflowDir), '.github/workflows/ must exist');
    workflows = loadWorkflows();
    assert.ok(workflows.length > 0, 'at least one workflow file must exist');
  });

  describe('Reject npm install (must use npm ci)', () => {
    it('no workflow uses bare npm install', () => {
      for (const wf of loadWorkflows()) {
        const lines = wf.content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          // Skip comments
          if (line.startsWith('#')) continue;
          // Match "npm install" but not "npm ci" and not part of a comment
          if (/\bnpm install\b/.test(line)) {
            assert.fail(`${wf.name}:${i + 1} uses "npm install" — must use "npm ci" for reproducible builds`);
          }
        }
      }
    });
  });

  describe('Reject force-tag operations (git tag -f)', () => {
    it('no workflow uses git tag -f', () => {
      for (const wf of loadWorkflows()) {
        const lines = wf.content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line.startsWith('#')) continue;
          if (/\bgit\s+tag\s+-f\b/.test(line) || /\bgit\s+tag\s+--force\b/.test(line)) {
            assert.fail(`${wf.name}:${i + 1} uses "git tag -f" — tags must be immutable`);
          }
        }
      }
    });
  });

  describe('Reject force push', () => {
    it('no workflow uses git push --force or -f', () => {
      for (const wf of loadWorkflows()) {
        const lines = wf.content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line.startsWith('#')) continue;
          if (/\bgit\s+push\s+.*--force\b/.test(line) || /\bgit\s+push\s+.*\s-f\b/.test(line)) {
            assert.fail(`${wf.name}:${i + 1} uses force push — pushes must be non-destructive`);
          }
        }
      }
    });
  });

  describe('Reject release deletion', () => {
    it('no workflow uses gh release delete', () => {
      for (const wf of loadWorkflows()) {
        const lines = wf.content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line.startsWith('#')) continue;
          if (/\bgh\s+release\s+delete\b/.test(line)) {
            assert.fail(`${wf.name}:${i + 1} uses "gh release delete" — releases must be immutable`);
          }
        }
      }
    });

    it('no workflow uses tag deletion via API or git', () => {
      for (const wf of loadWorkflows()) {
        const lines = wf.content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line.startsWith('#')) continue;
          if (/\bgit\s+push\s+.*:refs\/tags\//.test(line) || /\bgit\s+tag\s+-d\b/.test(line)) {
            assert.fail(`${wf.name}:${i + 1} deletes tags — tags must be immutable`);
          }
        }
      }
    });
  });

  describe('Reject mutable action tags', () => {
    it('all third-party uses: references must be SHA-pinned', () => {
      // First-party actions that are acceptable with SHA pins or local refs
      const localOrComposite = /^\.\//;

      for (const wf of loadWorkflows()) {
        const lines = wf.content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line.startsWith('#')) continue;

          const usesMatch = line.match(/^uses:\s*['"]?([^'"#\s]+)/);
          if (!usesMatch) continue;

          const ref = usesMatch[1];

          // Skip local actions
          if (localOrComposite.test(ref)) continue;

          // Must contain an @ separator
          const atIdx = ref.indexOf('@');
          if (atIdx === -1) {
            assert.fail(`${wf.name}:${i + 1} action ref "${ref}" has no version pin`);
            continue;
          }

          const version = ref.slice(atIdx + 1);

          // Reject mutable tags like v4, v4.2, v4.2.1 (semver-looking strings)
          // Accept only hex SHA references (at least 7 chars)
          const isSHA = /^[0-9a-f]{7,40}$/.test(version);
          if (!isSHA) {
            assert.fail(
              `${wf.name}:${i + 1} action "${ref}" uses mutable tag "${version}" — ` +
              'pin to a reviewed commit SHA (e.g., uses: actions/checkout@abcdef1  # v4.4.0)'
            );
          }
        }
      }
    });
  });

  describe('Reject pre-validation commits', () => {
    it('build-mobile.yml does not commit generated files before validation passes', () => {
      const buildWf = loadWorkflows().find(wf => wf.name === 'build-mobile.yml');
      if (!buildWf) return; // Other tests will catch missing workflow

      const lines = buildWf.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('#')) continue;
        // No git add + git commit in the validate job
        if (/\bgit\s+(add|commit)\b/.test(line)) {
          assert.fail(
            `build-mobile.yml:${i + 1} commits generated files — ` +
            'use "git diff --exit-code" to verify-only, or commit in a post-validation step'
          );
        }
      }
    });
  });
});
