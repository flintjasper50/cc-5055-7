import { runScenario, type ScenarioReport } from './run';
import type { ScenarioName } from './synth';
import { writeFileSync, mkdirSync } from 'node:fs';

const scenarios: ScenarioName[] = ['rotation', 'deformation', 'occlusion', 'combined'];

const fmt = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : 'inf');

async function main() {
  const out: ScenarioReport[] = [];
  console.log(
    'scenario      frames  boundary  p95    hausdorff  cp-mean  cp-max  drift  growth/f  identity  occlF  conflictF',
  );
  for (const scenario of scenarios) {
    const report = await runScenario({
      scenario,
      keyframeEvery: scenario === 'occlusion' || scenario === 'combined' ? 20 : 15,
    });
    out.push(report);
    console.log(
      `${scenario.padEnd(13)} ${String(report.frames).padStart(5)}  ${fmt(report.meanBoundary).padStart(8)}  ${fmt(report.meanP95).padStart(6)}  ${fmt(report.meanHausdorff).padStart(9)}  ${fmt(report.meanControl).padStart(7)}  ${fmt(report.maxControl).padStart(6)}  ${fmt(report.meanDrift).padStart(5)}  ${fmt(report.driftGrowthPerFrame, 3).padStart(8)}  ${(report.identityStability * 100).toFixed(1).padStart(6)}%  ${String(report.occludedFrameCount).padStart(5)}  ${String(report.conflictFrameCount).padStart(9)}`,
    );
  }
  mkdirSync('bench-out', { recursive: true });
  writeFileSync('bench-out/report.json', JSON.stringify(out, null, 2));
  console.log('\nwrote bench-out/report.json');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
