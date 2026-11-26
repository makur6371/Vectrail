import type { VectrailBridgeAPI } from '../preload';

declare global {
  interface Window {
    vectrail: VectrailBridgeAPI;
  }
}
