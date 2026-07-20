// Thin wrapper over the preload-exposed IPC bridge. Every call returns the
// resolved data or throws with the server-side error message.

async function call(method, payload) {
  const res = await window.api[method](payload);
  if (!res || res.ok === false) {
    throw new Error((res && res.error) || 'Something went wrong.');
  }
  return res.data;
}

export const api = {
  login: (username, password) => call('authLogin', { username, password }),
  logout: () => window.api.authLogout(),
  current: () => call('authCurrent'),

  listUsers: () => call('usersList'),
  createUser: (p) => call('usersCreate', p),
  updateUser: (p) => call('usersUpdate', p),
  deleteUser: (id) => call('usersDelete', id),
  clearEventStaff: (eventId) => call('usersClearEventStaff', eventId),

  listEvents: () => call('eventsList'),
  activeEvent: () => call('eventsActive'),
  createEvent: (p) => call('eventsCreate', p),
  updateEvent: (p) => call('eventsUpdate', p),
  setActiveEvent: (id) => call('eventsSetActive', id),
  setEventState: (id, active) => call('eventsSetState', { id, active }),
  deleteEvent: (id, force) => call('eventsDelete', { id, force }),

  createPatient: (p) => call('patientsCreate', p),
  updatePatient: (p) => call('patientsUpdate', p),
  deletePatient: (id) => call('patientsDelete', id),
  getPatient: (id) => call('patientsGet', id),
  listPatients: (opts) => call('patientsList', opts),
  records: (opts) => call('patientsRecords', opts),
  searchAll: (term) => call('patientsSearchAll', term),
  patientHistory: (id) => call('patientsHistory', id),
  listIncomplete: () => call('patientsIncomplete'),
  cleanupIncomplete: () => call('patientsCleanupIncomplete'),

  saveTriage: (patientId, data) => call('triageSave', { patientId, data }),
  saveTreatment: (patientId, data, finalize) => call('treatmentSave', { patientId, data, finalize }),
  saveVitals: (patientId, data) => call('vitalsSave', { patientId, data }),
  routePatient: (patientId, route) => call('patientsRoute', { patientId, route }),
  setConsentTeeth: (consentId, tooth_numbers) => call('consentSetTeeth', { consentId, tooth_numbers }),
  dismissPatient: (id) => call('patientsDismiss', id),
  movePatient: (id, target) => call('patientsMove', { id, target }),
  patientAudit: (id) => call('patientsAudit', id),

  usbList: () => call('usbList'),
  usbWriteCheckin: (patientId) => call('usbWriteCheckin', { patientId }),
  usbLoad: () => call('usbLoad'),
  usbUploadCheckout: () => call('usbUploadCheckout'),
  usbClear: (dir) => call('usbClear', { dir, choose: !dir }),

  addXray: (p) => call('xrayAdd', p),
  getXray: (id) => call('xrayGet', id),
  listXrays: (patientId) => call('xrayList', patientId),
  deleteXray: (id) => call('xrayDelete', id),

  dashboard: () => call('statsDashboard'),
  audit: (limit) => call('auditList', limit),

  pdfPreview: (patientId, format) => call('pdfPreview', { patientId, format }),
  pdfGenerate: (patientId, format) => call('pdfGenerate', { patientId, format }),
  pdfPrint: (patientId, format) => call('pdfPrint', { patientId, format }),
  exportRecordUsb: (patientId) => call('recordExportUsb', { patientId }),

  backup: () => call('backupRun'),
  exportEvent: () => call('exportEvent'),

  appVersion: () => call('appVersion'),
  checkUpdate: (opts) => call('updateCheck', opts || {}),
  installUpdate: (path) => call('updateInstall', { path }),

  // Online auto-update
  onlineUpdateAvailable: () => call('updateOnlineAvailable'),
  checkOnline: () => call('updateCheckOnline'),
  downloadOnline: () => call('updateDownloadOnline'),
  installOnline: () => call('updateInstallOnline'),
  onUpdateEvent: (cb) => window.api.onUpdateEvent(cb),

  // Cloud sync (v1.1.0)
  cloudStatus: () => call('cloudStatus'),
  cloudConfig: (cfg) => call('cloudConfig', cfg),
  cloudTest: (url, key) => call('cloudTest', { url, key }),
  cloudSyncNow: () => call('cloudSyncNow'),
  onCloudChanged: (cb) => window.api.onCloudChanged(cb),

  openExternal: (url) => window.api.appOpenExternal(url),
};
