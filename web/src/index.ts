/**
 * Public API of @sfagents/web: the web server behind `sfagents web`.
 */

export { WebServer, DEFAULT_HOST, DEFAULT_PORT, PUBLIC_DIR, parsePublicOrigin } from './server.js';
export { WebAuth, AuthError, newAccessToken, SESSION_COOKIE } from './auth.js';
export type { WebServerOptions } from './server.js';
export { Up2kStore, Up2kError, up2kChunkSize, chunkHash, DEFAULT_MAX_UPLOAD_BYTES } from './up2k.js';
export type { HandshakeRequest, HandshakeResponse } from './up2k.js';
export { SystemMonitor, nodeSystemSource, parseCpuinfo, NVIDIA_SMI_ARGS, parseMeminfo, parseDiskstats, parseNetDev, parseNetstatIb, parseVmStat, parseNvidiaSmi, parseIoregGpu, parseIoregDisk, parseMounts } from './system.js';
export type { SystemSnapshot, SystemSource, SystemMonitorOptions, DriveUsage, DiskCounters } from './system.js';
export { LhmClient, DEFAULT_LHM_URL, parseLhmTree, parseLhmValue, lhmReadings } from './lhm.js';
export type { LhmSensor, LhmReadings, LhmReader } from './lhm.js';
export { WindowsSensorClient, sensorEnvironment } from './windows-sensors.js';
export { LinuxSensorClient } from './linux-sensors.js';
export { describeCall, displayItems, displaySections } from './display.js';
export type { DisplayItem, DisplayArtifact, DisplayApproval, DisplayAttachment, DisplaySection } from './display.js';
export { FileService, FileError, typeOf, explain } from './files.js';
export type { FileEntry, FileInfo, FileKind, Job, Conflict, ConflictItem } from './files.js';
export { Trash, freeName } from './trash.js';
export { writeZip, zipSourcesFor, readZipEntries, extractZip, safeEntryPath, crc32, ZipError } from './zip.js';
export type { ZipSource, ZipEntry } from './zip.js';
export { PerformanceMonitor, parseNetDevByInterface, parseDiskstatsByDisk, parseMeminfoFields } from './performance.js';
export type { Detail, Point, DetailPoint } from './performance.js';
export { ProcessMonitor, ProcessError, parseProcStat, parsePs, parseEtime, parseWho, parseSystemctl, parseDesktopEntry, PRIORITY_LEVELS } from './processes.js';
export type { ProcessRow, ProcessDetail, ServiceRow, StartupRow } from './processes.js';
export { PowerShell } from './powershell.js';
export { AgentSettingsStore, EFFORT_LEVELS, ModelWindows, parseEffort } from './agent-settings.js';
export { Dictation, MODEL_FILES, wavSeconds, detectHardware, runtimeChoices, transcriptFromAnswer, deviceFromLog } from './dictation.js';
export type { DictationStatus, Hardware, Backend } from './dictation.js';
