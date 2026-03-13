/**
 * eda-mcp-server - 快照存储
 *
 * 内存中维护最新一份 CollectedData 快照，支持版本追踪。
 * MVP 阶段仅保留 1 份快照（不做多版本历史）。
 */
import type { CollectedData, RawProjectInfo } from './types.js';

export interface SnapshotEntry {
	/** 快照版本（由扩展端生成，单调递增） */
	version: number;
	/** 快照接收时间 */
	receivedAt: number;
	/** 扩展端生成时间 */
	timestamp: number;
	/** 工程信息 */
	projectUuid: string;
	projectName: string;
	/** 完整数据 */
	data: CollectedData;
}

/**
 * 快照存储（单例）
 */
export class SnapshotStore {
	private snapshot: SnapshotEntry | null = null;

	/**
	 * 更新快照
	 *
	 * 拒绝版本回滚：新版本号必须大于当前版本，否则忽略。
	 */
	update(version: number, projectUuid: string, timestamp: number, data: CollectedData): boolean {
		if (this.snapshot && version <= this.snapshot.version) {
			return false;
		}

		this.snapshot = {
			version,
			receivedAt: Date.now(),
			timestamp,
			projectUuid: projectUuid || data.projectInfo?.projectUuid || '',
			projectName: data.projectInfo?.projectName ?? '',
			data,
		};
		return true;
	}

	/**
	 * 获取当前快照（无数据时返回 null）
	 */
	get(): SnapshotEntry | null {
		return this.snapshot;
	}

	/**
	 * 获取快照版本
	 */
	getVersion(): number {
		return this.snapshot?.version ?? 0;
	}

	/**
	 * 获取工程信息
	 */
	getProjectInfo(): RawProjectInfo | undefined {
		return this.snapshot?.data.projectInfo;
	}

	/**
	 * 检查是否有可用数据
	 */
	hasData(): boolean {
		return this.snapshot !== null;
	}

	/**
	 * 重置版本基线
	 *
	 * 在新客户端连接（hello 握手）时调用，允许扩展重启后版本号从 1 重新开始。
	 * 保留现有数据不变，仅重置版本号为 0。
	 */
	resetVersionBaseline(): void {
		if (this.snapshot) {
			this.snapshot.version = 0;
		}
	}

	/**
	 * 清空快照
	 */
	clear(): void {
		this.snapshot = null;
	}
}
