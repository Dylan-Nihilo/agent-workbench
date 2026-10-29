import { contextBridge, ipcRenderer } from 'electron';
import type { AppEvent, WorkbenchBridge } from '../shared/types';

const bridge: WorkbenchBridge = {
  invoke: (action, payload) => ipcRenderer.invoke('workbench:invoke', action, payload),
  onEvent(callback) {
    const listener = (_event: Electron.IpcRendererEvent, value: AppEvent) => callback(value);
    ipcRenderer.on('workbench:event', listener);
    return () => ipcRenderer.removeListener('workbench:event', listener);
  },
};
contextBridge.exposeInMainWorld('workbench', bridge);
