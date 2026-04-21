/**
 * AI Schematic Assistant - extension entrypoint
 */
import { showConfigDialog } from './review/config';
import { isCollectionInProgress, startAIChat, triggerBackgroundCollection } from './review/orchestrator';

const AUTO_COLLECT_TIMER_ID = 'ai-sch-auto-collect';
const AUTO_COLLECT_INTERVAL_MS = 5000;

let autoCollectorInitialized = false;
let lastObservedSchematicUuid: string | null = null;

/**
 * Extension activation entrypoint. Initializes background collection monitoring.
 */
export function activate(status?: 'onStartupFinished', arg?: string): void {
	void status;
	void arg;

	if (autoCollectorInitialized) {
		return;
	}
	autoCollectorInitialized = true;

	// Defensively clear any existing timer to avoid duplicate registration.
	try {
		eda.sys_Timer.clearIntervalTimer(AUTO_COLLECT_TIMER_ID);
	}
	catch (error) {
		console.warn('[auto-collect] Failed to clear previous timer (safe to ignore):', error);
	}

	// Start the timer and check for document changes every 5 seconds.
	eda.sys_Timer.setIntervalTimer(
		AUTO_COLLECT_TIMER_ID,
		AUTO_COLLECT_INTERVAL_MS,
		() => {
			void probeDocumentAndTriggerCollection();
		},
	);

	// Run once immediately instead of waiting for the first interval.
	void probeDocumentAndTriggerCollection();
}

/**
 * Detect changes to the current document and trigger background collection.
 */
async function probeDocumentAndTriggerCollection(): Promise<void> {
	try {
		// Skip checks while collection is in progress to avoid interference from page switching.
		if (isCollectionInProgress()) {
			return;
		}

		const docInfo = await eda.dmt_SelectControl.getCurrentDocumentInfo();
		if (!docInfo || docInfo.documentType !== 1 || !docInfo.uuid) {
			// Not a valid schematic document.
			lastObservedSchematicUuid = null;
			return;
		}
		if (lastObservedSchematicUuid === docInfo.uuid) {
			// Document did not change.
			return;
		}
		lastObservedSchematicUuid = docInfo.uuid;
		console.warn('[auto-collect] Schematic switch detected, triggering background collection:', docInfo.uuid);
		// Trigger background collection without notifying the IFrame.
		void triggerBackgroundCollection(`doc-change:${docInfo.uuid}`, false);
	}
	catch (error) {
		console.warn('[auto-collect] Background document-change detection failed:', error);
	}
}

/**
 * AI schematic chat assistant entrypoint.
 */
export function aiSchematicReview(): void {
	startAIChat().catch((error) => {
		const message = error instanceof Error ? error.message : String(error);
		console.error('[aiSchematicReview] Failed to start AI chat:', message);
		try {
			eda.sys_Dialog.showInformationMessage(
				`Failed to start AI assistant: ${message}`,
				'Startup Failed',
			);
		}
		catch (dialogError) {
			console.warn('[aiSchematicReview] Failed to show startup error dialog:', dialogError);
		}
	});
}

/**
 * AI configuration entrypoint.
 */
export function aiReviewConfig(): void {
	showConfigDialog();
}
