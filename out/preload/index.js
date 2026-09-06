"use strict";
const electron = require("electron");
electron.contextBridge.exposeInMainWorld("topspeedBuilder", {
  createProject: (input) => electron.ipcRenderer.invoke("project:create", input),
  chooseProjectRoot: () => electron.ipcRenderer.invoke("project:chooseRoot"),
  openProjectDialog: () => electron.ipcRenderer.invoke("project:openDialog"),
  openProjectPath: (projectPath) => electron.ipcRenderer.invoke("project:openPath", projectPath),
  saveProject: (project) => electron.ipcRenderer.invoke("project:save", project),
  getRecentProjects: () => electron.ipcRenderer.invoke("project:recent"),
  removeRecentProject: (projectPath) => electron.ipcRenderer.invoke("project:removeRecent", projectPath),
  getSettings: () => electron.ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => electron.ipcRenderer.invoke("settings:save", settings),
  testConnection: (settings) => electron.ipcRenderer.invoke("settings:testConnection", settings),
  fetchModels: (settings) => electron.ipcRenderer.invoke("settings:fetchModels", settings),
  chooseReferenceImages: (projectPath) => electron.ipcRenderer.invoke("reference:chooseImages", projectPath),
  chooseMaskImage: (projectPath) => electron.ipcRenderer.invoke("reference:chooseMask", projectPath),
  generateAssets: (input) => electron.ipcRenderer.invoke("generate:assets", input),
  exportProject: (input) => electron.ipcRenderer.invoke("export:project", input),
  getHistory: (projectPath) => electron.ipcRenderer.invoke("history:get", projectPath),
  readImageDataUrl: (projectPath, filePath) => electron.ipcRenderer.invoke("image:dataUrl", projectPath, filePath),
  deleteAsset: (projectPath, assetId) => electron.ipcRenderer.invoke("project:deleteAsset", projectPath, assetId),
  showItemInFolder: (filePath) => electron.ipcRenderer.invoke("shell:showItem", filePath),
  showProjectItemInFolder: (projectPath, filePath) => electron.ipcRenderer.invoke("shell:showProjectItem", projectPath, filePath),
  openPath: (filePath) => electron.ipcRenderer.invoke("shell:openPath", filePath)
});
