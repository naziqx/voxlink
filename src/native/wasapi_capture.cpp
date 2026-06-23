#include <napi.h>
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <functiondiscoverykeys_devpkey.h>
#include <audioclientactivationparams.h>

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")
#pragma comment(lib, "uuid.lib")

static bool comInitialized = false;

static void ensureCOM() {
    if (!comInitialized) {
        CoInitializeEx(NULL, COINIT_MULTITHREADED);
        comInitialized = true;
    }
}

struct AudioSessionInfo {
    std::wstring name;
    DWORD pid;
    float volume;
    BOOL isMuted;
    BOOL isActive;
};

static IMMDeviceEnumerator* getDeviceEnumerator() {
    ensureCOM();
    IMMDeviceEnumerator* enumerator = nullptr;
    CoCreateInstance(__uuidof(MMDeviceEnumerator), NULL, CLSCTX_ALL,
                     __uuidof(IMMDeviceEnumerator), (void**)&enumerator);
    return enumerator;
}

static IMMDevice* getDefaultEndpoint(IMMDeviceEnumerator* enumerator) {
    IMMDevice* device = nullptr;
    enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
    return device;
}

static std::vector<AudioSessionInfo> enumerateSessions() {
    std::vector<AudioSessionInfo> sessions;
    ensureCOM();

    IMMDeviceEnumerator* enumerator = getDeviceEnumerator();
    if (!enumerator) return sessions;

    IMMDevice* device = getDefaultEndpoint(enumerator);
    if (!device) { enumerator->Release(); return sessions; }

    IAudioSessionManager2* sessionManager = nullptr;
    device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, NULL, (void**)&sessionManager);
    if (!sessionManager) { device->Release(); enumerator->Release(); return sessions; }

    IAudioSessionEnumerator* sessionEnum = nullptr;
    sessionManager->GetSessionEnumerator(&sessionEnum);
    if (!sessionEnum) {
        sessionManager->Release();
        device->Release();
        enumerator->Release();
        return sessions;
    }

    int count = 0;
    sessionEnum->GetCount(&count);

    for (int i = 0; i < count; i++) {
        IAudioSessionControl* control = nullptr;
        sessionEnum->GetSession(i, &control);
        if (!control) continue;

        IAudioSessionState state;
        control->GetState(&state);

        IAudioSessionDisplayName* displayName = nullptr;
        control->QueryInterface(__uuidof(IAudioSessionDisplayName), (void**)&displayName);
        wchar_t displayNameBuf[256] = {0};
        if (displayName) {
            displayName->GetDisplayName(displayNameBuf, 256);
            displayName->Release();
        }

        IAudioSessionControl2* control2 = nullptr;
        control->QueryInterface(__uuidof(IAudioSessionControl2), (void**)&control2);
        DWORD pid = 0;
        BOOL isSystem = FALSE;
        if (control2) {
            control2->GetProcessId(&pid);
            control2->IsSystemIsSystemSoundsSession(&isSystem);
            control2->Release();
        }

        ISimpleAudioVolume* volume = nullptr;
        control->QueryInterface(__uuidof(ISimpleAudioVolume), (void**)&volume);
        float vol = 1.0f;
        BOOL muted = FALSE;
        if (volume) {
            volume->GetMasterVolume(&vol);
            volume->GetMute(&muted);
            volume->Release();
        }

        AudioSessionInfo info;
        info.name = displayNameBuf;
        info.pid = pid;
        info.volume = vol;
        info.isMuted = muted;
        info.isActive = (state == AudioSessionState_Active);

        sessions.push_back(info);

        control->Release();
    }

    sessionEnum->Release();
    sessionManager->Release();
    device->Release();
    enumerator->Release();

    return sessions;
}

static bool setSessionMute(DWORD targetPid, BOOL mute) {
    ensureCOM();

    IMMDeviceEnumerator* enumerator = getDeviceEnumerator();
    if (!enumerator) return false;

    IMMDevice* device = getDefaultEndpoint(enumerator);
    if (!device) { enumerator->Release(); return false; }

    IAudioSessionManager2* sessionManager = nullptr;
    device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, NULL, (void**)&sessionManager);
    if (!sessionManager) { device->Release(); enumerator->Release(); return false; }

    IAudioSessionEnumerator* sessionEnum = nullptr;
    sessionManager->GetSessionEnumerator(&sessionEnum);
    if (!sessionEnum) {
        sessionManager->Release();
        device->Release();
        enumerator->Release();
        return false;
    }

    int count = 0;
    sessionEnum->GetCount(&count);
    bool found = false;

    for (int i = 0; i < count; i++) {
        IAudioSessionControl* control = nullptr;
        sessionEnum->GetSession(i, &control);
        if (!control) continue;

        IAudioSessionControl2* control2 = nullptr;
        control->QueryInterface(__uuidof(IAudioSessionControl2), (void**)&control2);
        if (control2) {
            DWORD pid = 0;
            control2->GetProcessId(&pid);
            if (pid == targetPid) {
                ISimpleAudioVolume* volume = nullptr;
                control->QueryInterface(__uuidof(ISimpleAudioVolume), (void**)&volume);
                if (volume) {
                    volume->SetMute(mute, NULL);
                    volume->Release();
                    found = true;
                }
            }
            control2->Release();
        }
        control->Release();
    }

    sessionEnum->Release();
    sessionManager->Release();
    device->Release();
    enumerator->Release();

    return found;
}

static bool setSessionVolumeByPid(DWORD targetPid, float volume) {
    ensureCOM();

    IMMDeviceEnumerator* enumerator = getDeviceEnumerator();
    if (!enumerator) return false;

    IMMDevice* device = getDefaultEndpoint(enumerator);
    if (!device) { enumerator->Release(); return false; }

    IAudioSessionManager2* sessionManager = nullptr;
    device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, NULL, (void**)&sessionManager);
    if (!sessionManager) { device->Release(); enumerator->Release(); return false; }

    IAudioSessionEnumerator* sessionEnum = nullptr;
    sessionManager->GetSessionEnumerator(&sessionEnum);
    if (!sessionEnum) {
        sessionManager->Release();
        device->Release();
        enumerator->Release();
        return false;
    }

    int count = 0;
    sessionEnum->GetCount(&count);
    bool found = false;

    for (int i = 0; i < count; i++) {
        IAudioSessionControl* control = nullptr;
        sessionEnum->GetSession(i, &control);
        if (!control) continue;

        IAudioSessionControl2* control2 = nullptr;
        control->QueryInterface(__uuidof(IAudioSessionControl2), (void**)&control2);
        if (control2) {
            DWORD pid = 0;
            control2->GetProcessId(&pid);
            if (pid == targetPid) {
                ISimpleAudioVolume* vol = nullptr;
                control->QueryInterface(__uuidof(ISimpleAudioVolume), (void**)&vol);
                if (vol) {
                    vol->SetMasterVolume(volume, NULL);
                    vol->Release();
                    found = true;
                }
            }
            control2->Release();
        }
        control->Release();
    }

    sessionEnum->Release();
    sessionManager->Release();
    device->Release();
    enumerator->Release();

    return found;
}

static DWORD getCurrentPid() {
    return GetCurrentProcessId();
}

// N-API Functions

static Napi::Value napi_enumerateSessions(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto sessions = enumerateSessions();
    Napi::Array result = Napi::Array::New(env, sessions.size());

    for (size_t i = 0; i < sessions.size(); i++) {
        Napi::Object obj = Napi::Object::New(env);
        // Convert wstring to UTF-8
        std::wstring wname = sessions[i].name;
        int len = WideCharToMultiByte(CP_UTF8, 0, wname.c_str(), -1, NULL, 0, NULL, NULL);
        std::string name(len - 1, 0);
        WideCharToMultiByte(CP_UTF8, 0, wname.c_str(), -1, &name[0], len, NULL, NULL);

        obj.Set("name", Napi::String::New(env, name));
        obj.Set("pid", Napi::Number::New(env, sessions[i].pid));
        obj.Set("volume", Napi::Number::New(env, sessions[i].volume));
        obj.Set("isMuted", Napi::Boolean::New(env, sessions[i].isMuted));
        obj.Set("isActive", Napi::Boolean::New(env, sessions[i].isActive));
        result.Set(i, obj);
    }

    return result;
}

static Napi::Value napi_muteSessionByPid(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2) {
        Napi::TypeError::New(env, "Expected (pid: number, mute: boolean)").ThrowAsJavaScriptException();
        return env.Null();
    }
    DWORD pid = (DWORD)info[0].As<Napi::Number>().Uint32Value();
    BOOL mute = info[1].As<Napi::Boolean>().Value();
    bool ok = setSessionMute(pid, mute);
    return Napi::Boolean::New(env, ok);
}

static Napi::Value napi_setSessionVolume(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2) {
        Napi::TypeError::New(env, "Expected (pid: number, volume: number)").ThrowAsJavaScriptException();
        return env.Null();
    }
    DWORD pid = (DWORD)info[0].As<Napi::Number>().Uint32Value();
    float vol = (float)info[1].As<Napi::Number>().DoubleValue();
    bool ok = setSessionVolumeByPid(pid, vol);
    return Napi::Boolean::New(env, ok);
}

static Napi::Value napi_getCurrentPid(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), getCurrentPid());
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("enumerateSessions", Napi::Function::New(env, napi_enumerateSessions));
    exports.Set("muteSessionByPid", Napi::Function::New(env, napi_muteSessionByPid));
    exports.Set("setSessionVolume", Napi::Function::New(env, napi_setSessionVolume));
    exports.Set("getCurrentPid", Napi::Function::New(env, napi_getCurrentPid));
    return exports;
}

NODE_API_MODULE(wasapi_capture, Init)
