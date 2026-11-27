import type { PluginSummary } from '../../shared/djiTypes';

export interface VectrailPlugin {
  readonly id: string;
  readonly name: string;
  readonly nameZh: string;
  readonly version: string;
  readonly description: string;
  readonly descriptionZh: string;
  readonly defaultEnabled?: boolean;
  init(): Promise<void> | void;
  dispose(): Promise<void> | void;
  onEnabledChange?(enabled: boolean): Promise<void> | void;
  getHealth?(): { healthy: boolean; error?: string };
}

export type RegisteredPluginRecord = {
  plugin: VectrailPlugin;
  summary: PluginSummary;
};
