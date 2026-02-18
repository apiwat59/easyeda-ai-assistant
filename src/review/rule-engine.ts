/**
 * AI原理图审查 - 本地规则引擎
 *
 * 实现确定性规则检查（100%准确）
 */
import type { CollectedData, ReviewIssue } from './types';
import { IssueSeverity } from './types';

/**
 * 运行所有本地规则
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
 * 规则1: 检查未连接的Power/Ground引脚
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
				title: `电源/地引脚未连接`,
				reason: `器件 ${pin.componentDesignator} 的 ${pin.pinType} 类型引脚 ${pin.pinNumber} (${pin.pinName}) 未连接到任何网络`,
				impact: '可能导致器件无法正常工作或产生不可预测的行为',
				confidence: 1.0,
				fix: `将引脚 ${pin.componentDesignator}.${pin.pinNumber} 连接到相应的电源或地网络`,
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
 * 规则2: 检查孤立网络（仅1个连接）
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
				title: `孤立网络`,
				reason: `网络 ${net.netName} 仅连接了1个引脚 (${pin.componentDesignator}.${pin.pinNumber})`,
				impact: '该网络可能是未完成的连接或错误的网络命名',
				confidence: 0.9,
				fix: `检查网络 ${net.netName} 是否应该连接到其他引脚，或者该引脚是否应该悬空`,
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
 * 规则3: 检查所有引脚都未连接的器件
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
				title: `器件完全未连接`,
				reason: `器件 ${component.designator} (${component.name}) 的所有引脚都未连接到任何网络`,
				impact: '该器件不会参与电路工作，可能是设计遗漏',
				confidence: 1.0,
				fix: `连接器件 ${component.designator} 的引脚到相应网络，或删除该器件`,
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
 * 规则4: 检查输出对输出冲突
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
				title: `输出引脚冲突`,
				reason: `网络 ${net.netName} 上连接了 ${outputPins.length} 个输出引脚: ${outputPins.map(p => `${p.componentDesignator}.${p.pinNumber}`).join(', ')}`,
				impact: '多个输出引脚连接到同一网络可能导致短路或信号冲突',
				confidence: 0.95,
				fix: `检查网络 ${net.netName} 的连接，确保只有一个输出驱动该网络`,
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
 * 规则5: 检查输入引脚无驱动源
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

		// 如果有输入引脚但没有输出引脚，可能缺少驱动源
		if (inputPins.length > 0 && outputPins.length === 0) {
			// 排除电源网络
			const netNameLower = net.netName.toLowerCase();
			if (netNameLower.includes('vcc') || netNameLower.includes('gnd') || netNameLower.includes('power')) {
				continue;
			}

			issues.push({
				id: `rule-input-no-driver-${net.netName}`,
				severity: IssueSeverity.SUGGESTION,
				title: `输入引脚可能缺少驱动源`,
				reason: `网络 ${net.netName} 上有 ${inputPins.length} 个输入引脚，但没有输出引脚驱动`,
				impact: '输入引脚可能处于浮空状态，导致不确定的逻辑电平',
				confidence: 0.8,
				fix: `检查网络 ${net.netName} 是否应该连接到输出引脚或添加上拉/下拉电阻`,
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
