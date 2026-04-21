/**
 * AI Schematic Review - local rule engine
 *
 * Implements deterministic rule checks with fully reliable results
 */
import type { CollectedData, ReviewIssue } from './types';
import { IssueSeverity } from './types';

/**
 * Run all local rules
 */
export function runLocalRules(data: CollectedData): ReviewIssue[] {
	const issues: ReviewIssue[] = [];

	issues.push(...checkUnconnectedPowerPins(data));
	issues.push(...checkIsolatedNets(data));
	issues.push(...checkUnconnectedComponents(data));
	issues.push(...checkOutputToOutputConflict(data));
	issues.push(...checkInputWithoutDriver(data));

	return issues;
}

/**
 * Rule 1: Check unconnected power and ground pins
 */
function checkUnconnectedPowerPins(data: CollectedData): ReviewIssue[] {
	const issues: ReviewIssue[] = [];

	for (const pin of data.pins) {
		const pinType = pin.pinType.toLowerCase();
		const isPowerPin = pinType.includes('power') || pinType.includes('ground');

		if (isPowerPin && !pin.netName) {
			issues.push({
				id: `rule-power-unconnected-${pin.primitiveId}`,
				severity: IssueSeverity.MUST_FIX,
				title: 'Unconnected power or ground pin',
				reason: `The ${pin.pinType} pin ${pin.pinNumber} (${pin.pinName}) on component ${pin.componentDesignator} is not connected to any net`,
				impact: 'This may prevent the component from operating correctly or cause unpredictable behavior',
				confidence: 1.0,
				fix: `Connect pin ${pin.componentDesignator}.${pin.pinNumber} to the appropriate power or ground net`,
				evidence: {
					components: [pin.componentDesignator],
					pins: [`${pin.componentDesignator}_${pin.pinNumber}`],
					nets: [],
				},
				source: 'rule-engine',
				ruleId: 'power-unconnected',
			});
		}
	}

	return issues;
}

/**
 * Rule 2: Check isolated nets with only one connection
 */
function checkIsolatedNets(data: CollectedData): ReviewIssue[] {
	const issues: ReviewIssue[] = [];

	for (const net of data.nets) {
		if (net.pinCount === 1) {
			const pin = data.pins.find(p => p.netName === net.netName);
			if (!pin)
				continue;

			issues.push({
				id: `rule-isolated-net-${net.netName}`,
				severity: IssueSeverity.SUGGESTION,
				title: 'Isolated net',
				reason: `Net ${net.netName} is connected to only one pin (${pin.componentDesignator}.${pin.pinNumber})`,
				impact: 'This net may be an incomplete connection or a wrongly named net',
				confidence: 0.9,
				fix: `Check whether net ${net.netName} should connect to other pins, or whether this pin is intended to remain floating`,
				evidence: {
					components: [pin.componentDesignator],
					pins: [`${pin.componentDesignator}_${pin.pinNumber}`],
					nets: [net.netName],
				},
				source: 'rule-engine',
				ruleId: 'isolated-net',
			});
		}
	}

	return issues;
}

/**
 * Rule 3: Check components whose pins are all unconnected
 */
function checkUnconnectedComponents(data: CollectedData): ReviewIssue[] {
	const issues: ReviewIssue[] = [];

	for (const component of data.components) {
		const componentPins = data.pins.filter(
			p => p.componentPrimitiveId === component.primitiveId,
		);

		if (componentPins.length === 0)
			continue;

		const connectedPins = componentPins.filter(p => p.netName !== null);

		if (connectedPins.length === 0) {
			issues.push({
				id: `rule-component-unconnected-${component.primitiveId}`,
				severity: IssueSeverity.MUST_FIX,
				title: 'Completely unconnected component',
				reason: `All pins on component ${component.designator} (${component.name}) are not connected to any net`,
				impact: 'This component does not participate in the circuit and may have been left out by mistake',
				confidence: 1.0,
				fix: `Connect the pins of component ${component.designator} to the appropriate nets, or remove the component`,
				evidence: {
					components: [component.designator],
					pins: componentPins.map(p => `${p.componentDesignator}_${p.pinNumber}`),
					nets: [],
				},
				source: 'rule-engine',
				ruleId: 'component-unconnected',
			});
		}
	}

	return issues;
}

/**
 * Rule 4: Check output-to-output conflicts
 */
function checkOutputToOutputConflict(data: CollectedData): ReviewIssue[] {
	const issues: ReviewIssue[] = [];

	for (const net of data.nets) {
		const pinsOnNet = data.pins.filter(p => p.netName === net.netName);
		const outputPins = pinsOnNet.filter(p =>
			p.pinType.toLowerCase().includes('output'),
		);

		if (outputPins.length > 1) {
			issues.push({
				id: `rule-output-conflict-${net.netName}`,
				severity: IssueSeverity.MUST_FIX,
				title: 'Output pin conflict',
				reason: `Net ${net.netName} has ${outputPins.length} output pins connected: ${outputPins.map(p => `${p.componentDesignator}.${p.pinNumber}`).join(', ')}`,
				impact: 'Multiple output pins connected to the same net may cause a short circuit or signal contention',
				confidence: 0.95,
				fix: `Inspect the connections on net ${net.netName} and ensure that only one output drives this net`,
				evidence: {
					components: outputPins.map(p => p.componentDesignator),
					pins: outputPins.map(p => `${p.componentDesignator}_${p.pinNumber}`),
					nets: [net.netName],
				},
				source: 'rule-engine',
				ruleId: 'output-conflict',
			});
		}
	}

	return issues;
}

/**
 * Rule 5: Check input pins with no driving source
 */
function checkInputWithoutDriver(data: CollectedData): ReviewIssue[] {
	const issues: ReviewIssue[] = [];

	for (const net of data.nets) {
		const pinsOnNet = data.pins.filter(p => p.netName === net.netName);
		const inputPins = pinsOnNet.filter(p =>
			p.pinType.toLowerCase().includes('input') && !p.pinType.toLowerCase().includes('output'),
		);
		const outputPins = pinsOnNet.filter(p =>
			p.pinType.toLowerCase().includes('output'),
		);

		// If there are input pins but no output pins, the net may be missing a driving source
		if (inputPins.length > 0 && outputPins.length === 0) {
			// Exclude power nets
			const netNameLower = net.netName.toLowerCase();
			if (netNameLower.includes('vcc') || netNameLower.includes('gnd') || netNameLower.includes('power')) {
				continue;
			}

			issues.push({
				id: `rule-input-no-driver-${net.netName}`,
				severity: IssueSeverity.SUGGESTION,
				title: 'Input pin may be missing a driving source',
				reason: `Net ${net.netName} has ${inputPins.length} input pins, but no output pin is driving it`,
				impact: 'The input pins may be floating, which can lead to undefined logic levels',
				confidence: 0.8,
				fix: `Check whether net ${net.netName} should connect to an output pin or whether a pull-up or pull-down resistor should be added`,
				evidence: {
					components: inputPins.map(p => p.componentDesignator),
					pins: inputPins.map(p => `${p.componentDesignator}_${p.pinNumber}`),
					nets: [net.netName],
				},
				source: 'rule-engine',
				ruleId: 'input-no-driver',
			});
		}
	}

	return issues;
}
