import type { EditroomBridgeAPI } from '../preload';

declare global {
  interface Window {
    editroom: EditroomBridgeAPI;
  }
}
