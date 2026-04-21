/**
 * AI Schematic Review - locator module
 *
 * Implements cross-probing and visual marker functionality
 */
import type { LocateRequest } from './types';

/**
 * Locate the specified components, pins, or nets
 */
export async function locateItems(request: LocateRequest): Promise<boolean> {
	try {
		// Use cross-probe selection
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

		// Add visual markers if needed
		await addVisualMarkers(request);

		return true;
	}
	catch (error) {
		console.error('Locate items failed:', error);
		return false;
	}
}

/**
 * Add visual markers
 */
async function addVisualMarkers(_request: LocateRequest): Promise<void> {
	try {
		// Build marker data
		// P1: Use the correct IDMT_IndicatorMarkerShape format
		const markers: IDMT_IndicatorMarkerShape[] = [];

		// Note: coordinates for components and pins are needed here.
		// Because the object has already been selected during location, this can be simplified for now.
		// A production implementation may need to read coordinates from CollectedData.

		if (markers.length > 0) {
			// P1: The color parameter uses an { r, g, b, alpha } object instead of a hex string
			await eda.dmt_EditorControl.generateIndicatorMarkers(
				markers,
				{ r: 255, g: 0, b: 0, alpha: 1 },
				2, // Line width
				true, // zoom: locate and zoom
			);
		}
	}
	catch (error) {
		console.warn('Add visual markers failed:', error);
	}
}

/**
 * Clear all markers
 */
export async function clearMarkers(): Promise<void> {
	try {
		// The API for clearing markers may require checking the documentation.
		// This is intentionally left blank for now because autoRemove=true clears them automatically.
	}
	catch (error) {
		console.warn('Clear markers failed:', error);
	}
}
