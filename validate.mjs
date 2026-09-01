import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const DIR = '/Users/mac/work-deepseek/kb/preset-kb-qa';
const files = ['preset.yml', 'agent.cordis.yml'].map((f) => `${DIR}/${f}`);
const py = `
import sys, json
try:
    import yaml
except Exception as e:
    print("NOPYYAML", e); sys.exit(3)
for f in sys.argv[1:]:
    try:
        d = yaml.safe_load(open(f, encoding="utf-8"))
    except Exception as e:
        print("FAIL", f, e); sys.exit(1)
    print("OK", f, json.dumps(d, ensure_ascii=False)[:220])
`;
const r = spawnSync('python3', ['-c', py, ...files], { encoding: 'utf8' });
console.log(r.stdout, r.stderr);
for (const f of files) {
  const t = readFileSync(`/Users/mac/work-deepseek/kb/preset-kb-qa/${f}`, 'utf8');
  console.log(`--- ${f}: ${t.length} bytes, ${t.split('\n').length} lines`);
}
