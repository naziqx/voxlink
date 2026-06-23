// wasapi_audio.c — WASAPI audio session management for VoxLink screen share
// Mutes VoxLink's own audio sessions during screen share to prevent loopback echo.

#include <node_api.h>
#include <windows.h>
#include <mmdeviceapi.h>
#include <audiopolicy.h>
#include <audioclient.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <string.h>

// ── Helpers ────────────────────────────────────────────────────────────────────

static void wcharToUtf8(const wchar_t *w, char *out, size_t outSize) {
  WideCharToMultiByte(CP_UTF8, 0, w, -1, out, (int)outSize, NULL, NULL);
}

static BOOL isVoxLinkProcess(const wchar_t *name) {
  if (!name || !name[0]) return FALSE;
  wchar_t lower[256] = {0};
  wcscpy_s(lower, 256, name);
  _wcslwr_s(lower, 256);
  return (wcsstr(lower, L"voxlink") != NULL) ||
         (wcsstr(lower, L"electron") != NULL);
}

// Get all PIDs for a given process name
static DWORD* getPidsByName(const wchar_t *targetName, int *count) {
  *count = 0;
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return NULL;

  DWORD *pids = (DWORD*)calloc(256, sizeof(DWORD));
  PROCESSENTRY32W pe = { .dwSize = sizeof(pe) };

  if (Process32FirstW(snap, &pe)) {
    do {
      if (isVoxLinkProcess(pe.szExeFile) && *count < 256) {
        pids[*count] = pe.th32ProcessID;
        (*count)++;
      }
    } while (Process32NextW(snap, &pe));
  }
  CloseHandle(snap);
  return pids;
}

// ── WASAPI session enumeration ──────────────────────────────────────────────────

typedef struct {
  DWORD pid;
  wchar_t name[256];
  float volume;
  BOOL isMuted;
} SessionInfo;

static int enumerateAudioSessions(SessionInfo *out, int maxOut) {
  int count = 0;
  IMMDeviceEnumerator *pEnum = NULL;
  IMMDevice *pDev = NULL;
  IAudioSessionManager2 *pMgr = NULL;
  IAudioSessionEnumerator *pSessEnum = NULL;
  IAudioSessionControl *pCtrl = NULL;
  IAudioSessionControl2 *pCtrl2 = NULL;
  ISimpleAudioVolume *pVol = NULL;

  CoInitializeEx(NULL, COINIT_MULTITHREADED);

  if (FAILED(CoCreateInstance(&CLSID_MMDeviceEnumerator, NULL, CLSCTX_ALL,
                              &IID_IMMDeviceEnumerator, (void**)&pEnum)))
    goto done;
  if (FAILED(IIMMDeviceEnumerator_GetDefaultAudioEndpoint(pEnum, eRender, eConsole, &pDev)))
    goto done;
  if (FAILED(IMMDevice_Activate(pDev, &IID_IAudioSessionManager2, CLSCTX_ALL, NULL, (void**)&pMgr)))
    goto done;
  if (FAILED(IAudioSessionManager2_GetSessionEnumerator(pMgr, &pSessEnum)))
    goto done;

  int total = 0;
  IAudioSessionEnumerator_GetCount(pSessEnum, &total);

  for (int i = 0; i < total && count < maxOut; i++) {
    if (FAILED(IAudioSessionEnumerator_GetSession(pSessEnum, i, &pCtrl)) || !pCtrl) continue;

    if (SUCCEEDED(IAudioSessionControl_QueryInterface(pCtrl, &IID_IAudioSessionControl2, (void**)&pCtrl2)) && pCtrl2) {
      DWORD pid = 0;
      IAudioSessionControl2_GetProcessId(pCtrl2, &pid);

      // Get display name
      wchar_t displayName[256] = {0};
      IAudioSessionControl2_GetDisplayName(pCtrl2, displayName, 256);

      float vol = 0.0f;
      BOOL muted = FALSE;
      if (SUCCEEDED(IAudioSessionControl_QueryInterface(pCtrl, &IID_ISimpleAudioVolume, (void**)&pVol)) && pVol) {
        ISimpleAudioVolume_GetMasterVolume(pVol, &vol);
        ISimpleAudioVolume_GetMute(pVol, &muted);
        ISimpleAudioVolume_Release(pVol);
        pVol = NULL;
      }

      out[count].pid = pid;
      wcscpy_s(out[count].name, 256, displayName[0] ? displayName : L"Unknown");
      out[count].volume = vol;
      out[count].isMuted = muted;
      count++;

      IAudioSessionControl2_Release(pCtrl2);
      pCtrl2 = NULL;
    }
    IAudioSessionControl_Release(pCtrl);
    pCtrl = NULL;
  }

done:
  if (pSessEnum) IAudioSessionEnumerator_Release(pSessEnum);
  if (pMgr) IAudioSessionManager2_Release(pMgr);
  if (pDev) IMMDevice_Release(pDev);
  if (pEnum) IMMDeviceEnumerator_Release(pEnum);
  CoUninitialize();
  return count;
}

static BOOL setSessionVolumeByPid(DWORD pid, float volume) {
  BOOL found = FALSE;
  IMMDeviceEnumerator *pEnum = NULL;
  IMMDevice *pDev = NULL;
  IAudioSessionManager2 *pMgr = NULL;
  IAudioSessionEnumerator *pSessEnum = NULL;
  IAudioSessionControl *pCtrl = NULL;
  IAudioSessionControl2 *pCtrl2 = NULL;
  ISimpleAudioVolume *pVol = NULL;

  CoInitializeEx(NULL, COINIT_MULTITHREADED);

  if (FAILED(CoCreateInstance(&CLSID_MMDeviceEnumerator, NULL, CLSCTX_ALL,
                              &IID_IMMDeviceEnumerator, (void**)&pEnum)))
    goto done;
  if (FAILED(IIMMDeviceEnumerator_GetDefaultAudioEndpoint(pEnum, eRender, eConsole, &pDev)))
    goto done;
  if (FAILED(IMMDevice_Activate(pDev, &IID_IAudioSessionManager2, CLSCTX_ALL, NULL, (void**)&pMgr)))
    goto done;
  if (FAILED(IAudioSessionManager2_GetSessionEnumerator(pMgr, &pSessEnum)))
    goto done;

  int total = 0;
  IAudioSessionEnumerator_GetCount(pSessEnum, &total);

  for (int i = 0; i < total; i++) {
    if (FAILED(IAudioSessionEnumerator_GetSession(pSessEnum, i, &pCtrl)) || !pCtrl) continue;

    if (SUCCEEDED(IAudioSessionControl_QueryInterface(pCtrl, &IID_IAudioSessionControl2, (void**)&pCtrl2)) && pCtrl2) {
      DWORD sessionPid = 0;
      IAudioSessionControl2_GetProcessId(pCtrl2, &sessionPid);

      if (sessionPid == pid) {
        if (SUCCEEDED(IAudioSessionControl_QueryInterface(pCtrl, &IID_ISimpleAudioVolume, (void**)&pVol)) && pVol) {
          ISimpleAudioVolume_SetMasterVolume(pVol, volume, NULL);
          found = TRUE;
          ISimpleAudioVolume_Release(pVol);
          pVol = NULL;
        }
      }
      IAudioSessionControl2_Release(pCtrl2);
      pCtrl2 = NULL;
    }
    IAudioSessionControl_Release(pCtrl);
    pCtrl = NULL;
  }

done:
  if (pSessEnum) IAudioSessionEnumerator_Release(pSessEnum);
  if (pMgr) IAudioSessionManager2_Release(pMgr);
  if (pDev) IMMDevice_Release(pDev);
  if (pEnum) IMMDeviceEnumerator_Release(pEnum);
  CoUninitialize();
  return found;
}

// ── N-API exports ──────────────────────────────────────────────────────────────

// getCurrentPid() -> number
static napi_value GetCurrentPid(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_create_uint32(env, (uint32_t)GetCurrentProcessId(), &result);
  return result;
}

// enumerateSessions() -> [{pid, name, volume, isMuted}]
static napi_value EnumerateSessions(napi_env env, napi_callback_info info) {
  SessionInfo sessions[256];
  int count = enumerateAudioSessions(sessions, 256);

  napi_value arr;
  napi_create_array_with_length(env, count, &arr);

  for (int i = 0; i < count; i++) {
    napi_value obj, val;
    napi_create_object(env, &obj);

    napi_create_uint32(env, sessions[i].pid, &val);
    napi_set_named_property(env, obj, "pid", val);

    char nameUtf8[512];
    wcharToUtf8(sessions[i].name, nameUtf8, sizeof(nameUtf8));
    napi_create_string_utf8(env, nameUtf8, NAPI_AUTO_LENGTH, &val);
    napi_set_named_property(env, obj, "name", val);

    napi_create_double(env, sessions[i].volume, &val);
    napi_set_named_property(env, obj, "volume", val);

    napi_get_boolean(env, sessions[i].isMuted, &val);
    napi_set_named_property(env, obj, "isMuted", val);

    napi_set_element(env, arr, i, obj);
  }

  return arr;
}

// muteSessionByPid(pid, mute) -> boolean
static napi_value MuteSessionByPid(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);

  uint32_t pid = 0;
  bool mute = true;
  napi_get_value_uint32(env, args[0], &pid);
  napi_get_value_bool(env, args[1], &mute);

  BOOL ok = setSessionVolumeByPid((DWORD)pid, mute ? 0.0f : 1.0f);
  napi_value result;
  napi_get_boolean(env, ok, &result);
  return result;
}

// ── Module init ────────────────────────────────────────────────────────────────

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;

  napi_create_function(env, "getCurrentPid", NAPI_AUTO_LENGTH, GetCurrentPid, NULL, &fn);
  napi_set_named_property(env, exports, "getCurrentPid", fn);

  napi_create_function(env, "enumerateSessions", NAPI_AUTO_LENGTH, EnumerateSessions, NULL, &fn);
  napi_set_named_property(env, exports, "enumerateSessions", fn);

  napi_create_function(env, "muteSessionByPid", NAPI_AUTO_LENGTH, MuteSessionByPid, NULL, &fn);
  napi_set_named_property(env, exports, "muteSessionByPid", fn);

  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
