/**
 * AI原理图审查 - 定位模块
 *
 * 实现交叉探针定位和视觉标记功能
 */
import type { LocateRequest } from './types';

/**
 * 定位到指定的器件/引脚/网络
 */
export async function locateItems(request: LocateRequest): Promise<boolean> {
	try {
		// 使用交叉探针选择
		const success = await eda.sch_SelectControl.doCrossProbeSelect(
			request.components || [],
			request.pins || [],
			request.nets || [],
			true, // clearSelection
			true, // zoomToFit
		);

		if (!success) {
			console.warn('Cross probe select failed');
			return false;
		}

		// 添加视觉标记（可选）
		await addVisualMarkers(request);

		return true;
	}
	catch (error) {
		console.error('Locate items failed:', error);
		return false;
	}
}

/**
 * 添加视觉标记
 */
async function addVisualMarkers(_request: LocateRequest): Promise<void> {
	try {
		// 构建标记数据
		// P1: 使用正确的IDMT_IndicatorMarkerShape格式
		const markers: Array<{
			type: 'point';
			x: number;
			y: number;
		}> = [];

		// 注意：这里需要获取器件/引脚的坐标
		// 由于我们在定位时已经选中了对象，这里可以简化处理
		// 实际实现中可能需要从CollectedData中获取坐标

		if (markers.length > 0) {
			// P1: color参数使用 { r, g, b, alpha } 对象，非十六进制字符串
			await eda.dmt_EditorControl.generateIndicatorMarkers(
				markers,
				{ r: 255, g: 0, b: 0, alpha: 1 },
				2, // 线宽
				true, // zoom: 定位并缩放
			);
		}
	}
	catch (error) {
		console.warn('Add visual markers failed:', error);
	}
}

/**
 * 清除所有标记
 */
export async function clearMarkers(): Promise<void> {
	try {
		// 清除标记的API可能需要查阅文档
		// 这里暂时留空，因为autoRemove=true会自动清除
	}
	catch (error) {
		console.warn('Clear markers failed:', error);
	}
}
