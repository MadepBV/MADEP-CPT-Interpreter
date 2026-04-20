#!/usr/bin/env node

import {
	NEN6740_MATERIALS,
	NEN6740_RF_SLOPE,
	NEN6740_STRESS_EXPONENT,
	classifyNen6740Reading
} from '../src/lib/cpt-app/nen6740.js';

function regressionStats(points){
	const xs = points.map((point) => point.rf);
	const ys = points.map((point) => Math.log10(point.qcNen));
	const xMean = xs.reduce((sum, value) => sum + value, 0) / xs.length;
	const yMean = ys.reduce((sum, value) => sum + value, 0) / ys.length;

	let cov = 0;
	let varX = 0;
	for(let i = 0; i < points.length; i += 1){
		cov += (xs[i] - xMean) * (ys[i] - yMean);
		varX += (xs[i] - xMean) ** 2;
	}

	const slope = cov / varX;
	const intercept = yMean - slope * xMean;
	const ssTot = ys.reduce((sum, value) => sum + (value - yMean) ** 2, 0);
	const ssRes = ys.reduce((sum, value, index) => {
		const pred = intercept + slope * xs[index];
		return sum + (value - pred) ** 2;
	}, 0);
	const r2 = 1 - ssRes / ssTot;

	return { slope, intercept, r2 };
}

function measuredQcForCentre(qcNen, sigVeff){
	return qcNen / Math.pow(100 / Math.max(sigVeff, 1), NEN6740_STRESS_EXPONENT);
}

const regression = regressionStats(NEN6740_MATERIALS);
const roundTripStresses = [25, 100, 400];
const failures = [];

for(const area of NEN6740_MATERIALS){
	for(const sigVeff of roundTripStresses){
		const qc = measuredQcForCentre(area.qcNen, sigVeff);
		const classified = classifyNen6740Reading({ qc, rf:area.rf, sigVeff });

		if(classified.area.order !== area.order){
			failures.push(
				`${area.order} ${area.subtype} failed round-trip at sigma'v0=${sigVeff} kPa ` +
				`(got ${classified.area.order} ${classified.area.subtype})`
			);
		}
	}
}

console.log(`NEN 6740 RF slope in code: ${NEN6740_RF_SLOPE.toFixed(2)}`);
console.log(
	`Regression through stored centres: slope=${regression.slope.toFixed(3)}, ` +
	`intercept=${regression.intercept.toFixed(3)}, R^2=${regression.r2.toFixed(3)}`
);
console.log(
	`Round-trip check: ${NEN6740_MATERIALS.length} centres x ${roundTripStresses.length} stress levels`
);

if(Math.abs(Math.abs(regression.slope) - NEN6740_RF_SLOPE) > 0.02){
	failures.push(
		`Stored-centre regression slope magnitude ${Math.abs(regression.slope).toFixed(3)} ` +
		`is not in sync with configured coefficient ${NEN6740_RF_SLOPE.toFixed(2)}`
	);
}

if(failures.length){
	console.error('\nNEN 6740 verification failed:');
	for(const failure of failures) console.error(`- ${failure}`);
	process.exit(1);
}

console.log('NEN 6740 verification passed.');
