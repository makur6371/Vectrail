import type { PluginSummary } from '../../shared/djiTypes';
import { getPluginEnabledState, setPluginEnabledState } from '../settings';
import type { RegisteredPluginRecord, VectrailPlugin } from './types';

export class PluginManager {
  private readonly plugins = new Map<string, RegisteredPluginRecord>();

  register(plugin: VectrailPlugin): void {
    const enabled = getPluginEnabledState(plugin.id, plugin.defaultEnabled ?? true);
    this.plugins.set(plugin.id, {
      plugin,
      summary: {
        id: plugin.id,
        name: plugin.name,
        nameZh: plugin.nameZh,
        version: plugin.version,
        description: plugin.description,
        descriptionZh: plugin.descriptionZh,
        enabled,
        healthy: true,
      },
    });
  }

  async initAll(): Promise<void> {
    for (const rec of this.plugins.values()) {
      if (!rec.summary.enabled) continue;
      try {
        await rec.plugin.init();
        rec.summary.healthy = true;
        rec.summary.error = undefined;
      } catch (err) {
        rec.summary.healthy = false;
        rec.summary.error = err instanceof Error ? err.message : String(err);
      }
    }
  }

  async disposeAll(): Promise<void> {
    for (const rec of this.plugins.values()) {
      try {
        await rec.plugin.dispose();
      } catch {
        // Fault isolation during shutdown.
      }
    }
  }

  isEnabled(pluginId: string): boolean {
    return this.plugins.get(pluginId)?.summary.enabled ?? false;
  }

  async setEnabled(pluginId: string, enabled: boolean): Promise<PluginSummary[]> {
    const rec = this.plugins.get(pluginId);
    if (!rec) return this.list();
    setPluginEnabledState(pluginId, enabled);
    rec.summary.enabled = enabled;
    try {
      if (enabled) {
        await rec.plugin.init();
      } else {
        await rec.plugin.dispose();
      }
      await rec.plugin.onEnabledChange?.(enabled);
      rec.summary.healthy = true;
      rec.summary.error = undefined;
    } catch (err) {
      rec.summary.healthy = false;
      rec.summary.error = err instanceof Error ? err.message : String(err);
    }
    return this.list();
  }

  list(): PluginSummary[] {
    return [...this.plugins.values()].map((rec) => {
      const health = rec.plugin.getHealth?.();
      return {
        ...rec.summary,
        healthy: health ? health.healthy : rec.summary.healthy,
        error: health?.error ?? rec.summary.error,
      };
    });
  }
}
