// zunewpd.exe — Windows Portable Devices bridge between Mune Player and a Zune.
//
// It talks to the Zune through Microsoft's own Zune driver (installed with the
// Zune software). That driver performs the MTPZ handshake itself, so no driver
// swap or key files are needed.
//
//   zunewpd serve            JSON-lines request/response loop on stdin/stdout (used by the app)
//   zunewpd probe            one-shot report: devices, the Zune's info, top of its object tree
//   zunewpd tree [depth]     dump the object tree
//   zunewpd props <id>...    dump every property of the given objects
//
// How the Zune organises music (matches what the Zune software writes):
//   tracks   Music\<album artist>\<album>\<file>, with ArtistId (MTP 0xDAB9) and
//            AlbumId (0xDABB) pointing at the objects below
//   artists  format 0xB218, "<name>.art", usually under Artists\
//   albums   format 0xBA03, "<artist>--<album>.alb", usually under Albums\, with
//            ArtistId, references to its tracks and the cover as album art

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <objbase.h>
#include <PortableDeviceApi.h>
#include <PortableDevice.h>
#include <WpdMtpExtensions.h>
#include <wrl/client.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <algorithm>
#include <map>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;

// ================================================================== strings & JSON
static std::string utf8(const wchar_t* w) {
  if (!w) return "";
  int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  std::string s(n > 0 ? n - 1 : 0, '\0');
  if (n > 1) WideCharToMultiByte(CP_UTF8, 0, w, -1, &s[0], n, nullptr, nullptr);
  return s;
}
static std::string utf8(const std::wstring& w) { return utf8(w.c_str()); }

static std::wstring wide(const std::string& s) {
  if (s.empty()) return L"";
  int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
  std::wstring w(n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &w[0], n);
  return w;
}

static std::string jstr(const std::string& s) {
  std::string o = "\"";
  for (unsigned char c : s) {
    switch (c) {
      case '"': o += "\\\""; break;
      case '\\': o += "\\\\"; break;
      case '\n': o += "\\n"; break;
      case '\r': o += "\\r"; break;
      case '\t': o += "\\t"; break;
      default:
        if (c < 0x20) {
          char b[8];
          sprintf_s(b, "\\u%04x", c);
          o += b;
        } else {
          o += (char)c;
        }
    }
  }
  return o + "\"";
}
static std::string jstr(const wchar_t* w) { return jstr(utf8(w)); }
static std::string jstr(const std::wstring& w) { return jstr(utf8(w)); }

static std::string hexHr(HRESULT hr) {
  char b[16];
  sprintf_s(b, "0x%08lX", (unsigned long)hr);
  return b;
}

static std::string guidStr(const GUID& g) {
  wchar_t buf[64];
  StringFromGUID2(g, buf, 64);
  return utf8(buf);
}

/** Minimal JSON value + parser, enough for the app's requests. */
struct JVal {
  enum Type { Null, Bool, Num, Str, Arr, Obj } t = Null;
  bool b = false;
  double n = 0;
  std::string s;
  std::vector<JVal> a;
  std::vector<std::pair<std::string, JVal>> o;

  const JVal* get(const char* k) const {
    for (auto& p : o)
      if (p.first == k) return &p.second;
    return nullptr;
  }
  std::string str(const char* k, const std::string& def = "") const {
    auto v = get(k);
    return v && v->t == Str ? v->s : def;
  }
  double num(const char* k, double def = 0) const {
    auto v = get(k);
    return v && v->t == Num ? v->n : def;
  }
  bool has(const char* k) const {
    auto v = get(k);
    return v && v->t != Null;
  }
};

struct JParser {
  const char* p;
  const char* e;
  bool ok = true;
  void ws() {
    while (p < e && (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r')) p++;
  }
  static void put(std::string& out, unsigned cp) {
    if (cp < 0x80) out += (char)cp;
    else if (cp < 0x800) {
      out += (char)(0xC0 | (cp >> 6));
      out += (char)(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
      out += (char)(0xE0 | (cp >> 12));
      out += (char)(0x80 | ((cp >> 6) & 0x3F));
      out += (char)(0x80 | (cp & 0x3F));
    } else {
      out += (char)(0xF0 | (cp >> 18));
      out += (char)(0x80 | ((cp >> 12) & 0x3F));
      out += (char)(0x80 | ((cp >> 6) & 0x3F));
      out += (char)(0x80 | (cp & 0x3F));
    }
  }
  unsigned hex4() {
    if (e - p < 4) {
      ok = false;
      return 0;
    }
    unsigned v = 0;
    for (int i = 0; i < 4; i++) {
      char c = *p++;
      v <<= 4;
      if (c >= '0' && c <= '9') v |= c - '0';
      else if (c >= 'a' && c <= 'f') v |= c - 'a' + 10;
      else if (c >= 'A' && c <= 'F') v |= c - 'A' + 10;
      else ok = false;
    }
    return v;
  }
  std::string str() {
    std::string out;
    p++;  // opening quote
    while (p < e && *p != '"') {
      if (*p == '\\') {
        p++;
        if (p >= e) break;
        char c = *p++;
        switch (c) {
          case 'n': out += '\n'; break;
          case 't': out += '\t'; break;
          case 'r': out += '\r'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'u': {
            unsigned cp = hex4();
            if (cp >= 0xD800 && cp <= 0xDBFF && e - p >= 6 && p[0] == '\\' && p[1] == 'u') {
              p += 2;
              unsigned lo = hex4();
              cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
            }
            put(out, cp);
            break;
          }
          default: out += c;
        }
      } else {
        out += *p++;
      }
    }
    if (p < e) p++;
    else ok = false;
    return out;
  }
  JVal value() {
    JVal v;
    ws();
    if (p >= e) {
      ok = false;
      return v;
    }
    if (*p == '{') {
      v.t = JVal::Obj;
      p++;
      ws();
      if (p < e && *p == '}') {
        p++;
        return v;
      }
      while (ok && p < e) {
        ws();
        if (*p != '"') {
          ok = false;
          break;
        }
        std::string k = str();
        ws();
        if (p >= e || *p != ':') {
          ok = false;
          break;
        }
        p++;
        v.o.emplace_back(k, value());
        ws();
        if (p < e && *p == ',') {
          p++;
          continue;
        }
        if (p < e && *p == '}') {
          p++;
          break;
        }
        ok = false;
      }
    } else if (*p == '[') {
      v.t = JVal::Arr;
      p++;
      ws();
      if (p < e && *p == ']') {
        p++;
        return v;
      }
      while (ok && p < e) {
        v.a.push_back(value());
        ws();
        if (p < e && *p == ',') {
          p++;
          continue;
        }
        if (p < e && *p == ']') {
          p++;
          break;
        }
        ok = false;
      }
    } else if (*p == '"') {
      v.t = JVal::Str;
      v.s = str();
    } else if (!strncmp(p, "true", 4)) {
      v.t = JVal::Bool;
      v.b = true;
      p += 4;
    } else if (!strncmp(p, "false", 5)) {
      v.t = JVal::Bool;
      p += 5;
    } else if (!strncmp(p, "null", 4)) {
      p += 4;
    } else {
      char* end = nullptr;
      v.n = strtod(p, &end);
      if (end == p) ok = false;
      v.t = JVal::Num;
      p = end;
    }
    return v;
  }
};

// ================================================================== WPD helpers
static const GUID MTP_FORMAT_BASE = {0x00000000, 0xAE6C, 0x4804, {0x98, 0xBA, 0xC5, 0x7B, 0x46, 0x96, 0x5F, 0xE7}};
static const GUID MTP_VENDOR_PROPS = {0x4D545058, 0x4FCE, 0x4578, {0x95, 0xC8, 0x86, 0x98, 0xA9, 0xBC, 0x0F, 0x49}};

static GUID mtpFormat(WORD code) {
  GUID g = MTP_FORMAT_BASE;
  g.Data1 = (DWORD)code << 16;
  return g;
}

static int mtpFormatCode(const GUID& g) {
  if (g.Data2 != MTP_FORMAT_BASE.Data2 || g.Data3 != MTP_FORMAT_BASE.Data3 || memcmp(g.Data4, MTP_FORMAT_BASE.Data4, 8) != 0 || (g.Data1 & 0xFFFF)) return -1;
  return (int)(g.Data1 >> 16);
}

static PROPERTYKEY mtpProp(DWORD code) { return {MTP_VENDOR_PROPS, code}; }

// Zune-specific object properties (see header comment).
static const DWORD PROP_ARTIST_ID = 0xDAB9;
static const DWORD PROP_ALBUM_ID = 0xDABB;
static const WORD FMT_ARTIST = 0xB218;
static const WORD FMT_ALBUM = 0xBA03;
static const WORD FMT_PLAYLIST = 0xBA05;

/** MTP object handles map to WPD ids as "o" + hex, e.g. 0x0600001E -> "o600001E". */
static ULONG handleOf(const std::wstring& id) {
  if (id.size() < 2 || (id[0] != L'o' && id[0] != L'O')) return 0;
  return wcstoul(id.c_str() + 1, nullptr, 16);
}

static std::wstring idOf(ULONG handle) {
  wchar_t b[16];
  swprintf_s(b, L"o%X", handle);
  return b;
}

static ComPtr<IPortableDeviceValues> newValues() {
  ComPtr<IPortableDeviceValues> v;
  CoCreateInstance(CLSID_PortableDeviceValues, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&v));
  return v;
}

static ComPtr<IPortableDeviceKeyCollection> newKeys(std::initializer_list<PROPERTYKEY> list) {
  ComPtr<IPortableDeviceKeyCollection> k;
  CoCreateInstance(CLSID_PortableDeviceKeyCollection, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&k));
  for (auto& key : list) k->Add(key);
  return k;
}

static ComPtr<IPortableDevicePropVariantCollection> newIdCollection(const std::vector<std::wstring>& ids) {
  ComPtr<IPortableDevicePropVariantCollection> c;
  CoCreateInstance(CLSID_PortableDevicePropVariantCollection, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&c));
  for (auto& id : ids) {
    PROPVARIANT pv;
    PropVariantInit(&pv);
    pv.vt = VT_LPWSTR;
    pv.pwszVal = const_cast<LPWSTR>(id.c_str());
    c->Add(&pv);  // Add copies the value
  }
  return c;
}

static std::string getStr(IPortableDeviceValues* v, REFPROPERTYKEY key) {
  PWSTR s = nullptr;
  if (SUCCEEDED(v->GetStringValue(key, &s)) && s) {
    std::string out = utf8(s);
    CoTaskMemFree(s);
    return out;
  }
  return "";
}

static bool getU64(IPortableDeviceValues* v, REFPROPERTYKEY key, ULONGLONG* out) { return SUCCEEDED(v->GetUnsignedLargeIntegerValue(key, out)); }
static bool getU32(IPortableDeviceValues* v, REFPROPERTYKEY key, ULONG* out) { return SUCCEEDED(v->GetUnsignedIntegerValue(key, out)); }
static bool getGuid(IPortableDeviceValues* v, REFPROPERTYKEY key, GUID* out) { return SUCCEEDED(v->GetGuidValue(key, out)); }

static std::vector<std::wstring> getIdList(IPortableDeviceValues* v, REFPROPERTYKEY key) {
  std::vector<std::wstring> out;
  ComPtr<IPortableDevicePropVariantCollection> c;
  if (FAILED(v->GetIPortableDevicePropVariantCollectionValue(key, &c)) || !c) return out;
  DWORD n = 0;
  c->GetCount(&n);
  for (DWORD i = 0; i < n; i++) {
    PROPVARIANT pv;
    PropVariantInit(&pv);
    if (SUCCEEDED(c->GetAt(i, &pv)) && pv.vt == VT_LPWSTR && pv.pwszVal) out.push_back(pv.pwszVal);
    PropVariantClear(&pv);
  }
  return out;
}

// ================================================================== output
static CRITICAL_SECTION g_out;

static void emit(const std::string& line) {
  EnterCriticalSection(&g_out);
  fwrite(line.data(), 1, line.size(), stdout);
  fputc('\n', stdout);
  fflush(stdout);
  LeaveCriticalSection(&g_out);
}

struct Reply {
  std::string body;
  void add(const char* k, const std::string& jsonValue) { body += std::string(",\"") + k + "\":" + jsonValue; }
};

// ================================================================== bulk property reads
class BulkCallback : public IPortableDevicePropertiesBulkCallback {
  LONG ref_ = 1;

 public:
  HANDLE done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  HRESULT status = S_OK;
  std::vector<ComPtr<IPortableDeviceValues>> results;
  CRITICAL_SECTION cs;
  BulkCallback() { InitializeCriticalSection(&cs); }
  ~BulkCallback() {
    CloseHandle(done);
    DeleteCriticalSection(&cs);
  }
  STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (riid == IID_IUnknown || riid == IID_IPortableDevicePropertiesBulkCallback) {
      *ppv = static_cast<IPortableDevicePropertiesBulkCallback*>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&ref_); }
  STDMETHODIMP_(ULONG) Release() override {
    LONG r = InterlockedDecrement(&ref_);
    if (!r) delete this;
    return r;
  }
  STDMETHODIMP OnStart(REFGUID) override { return S_OK; }
  STDMETHODIMP OnProgress(REFGUID, IPortableDeviceValuesCollection* coll) override {
    DWORD n = 0;
    coll->GetCount(&n);
    EnterCriticalSection(&cs);
    for (DWORD i = 0; i < n; i++) {
      ComPtr<IPortableDeviceValues> v;
      if (SUCCEEDED(coll->GetAt(i, &v))) results.push_back(v);
    }
    LeaveCriticalSection(&cs);
    return S_OK;
  }
  STDMETHODIMP OnEnd(REFGUID, HRESULT hr) override {
    status = hr;
    SetEvent(done);
    return S_OK;
  }
};

// ================================================================== the device
class Zune {
 public:
  ComPtr<IPortableDevice> dev;
  ComPtr<IPortableDeviceContent> content;
  ComPtr<IPortableDeviceProperties> props;
  std::wstring deviceId;
  std::wstring storageId;
  std::map<std::wstring, std::wstring> folderCache;  // "Music|Queen|Greatest Hits" -> object id

  bool isOpen() const { return dev != nullptr; }

  static std::vector<std::pair<std::wstring, std::string>> list(bool zuneOnly, std::string* json) {
    std::vector<std::pair<std::wstring, std::string>> out;
    ComPtr<IPortableDeviceManager> mgr;
    if (FAILED(CoCreateInstance(CLSID_PortableDeviceManager, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&mgr)))) return out;
    mgr->RefreshDeviceList();
    DWORD n = 0;
    mgr->GetDevices(nullptr, &n);
    std::vector<PWSTR> ids(n);
    if (n) mgr->GetDevices(ids.data(), &n);
    std::string arr;
    for (DWORD i = 0; i < n; i++) {
      auto read = [&](HRESULT (STDMETHODCALLTYPE IPortableDeviceManager::*fn)(LPCWSTR, WCHAR*, DWORD*)) {
        DWORD len = 0;
        (mgr.Get()->*fn)(ids[i], nullptr, &len);
        if (!len) return std::string();
        std::wstring buf(len, L'\0');
        if (FAILED((mgr.Get()->*fn)(ids[i], &buf[0], &len))) return std::string();
        return utf8(buf.c_str());
      };
      std::string name = read(&IPortableDeviceManager::GetDeviceFriendlyName);
      std::string desc = read(&IPortableDeviceManager::GetDeviceDescription);
      std::string maker = read(&IPortableDeviceManager::GetDeviceManufacturer);
      std::string lower = utf8(ids[i]);
      for (auto& c : lower) c = (char)tolower((unsigned char)c);
      bool zune = lower.find("vid_045e&pid_063e") != std::string::npos || lower.find("vid_045e&pid_0710") != std::string::npos ||
                  desc.find("Zune") != std::string::npos;
      if (!zuneOnly || zune) {
        out.emplace_back(ids[i], name);
        if (!arr.empty()) arr += ",";
        arr += "{\"id\":" + jstr(ids[i]) + ",\"name\":" + jstr(name) + ",\"description\":" + jstr(desc) + ",\"manufacturer\":" + jstr(maker) +
               ",\"zune\":" + (zune ? "true" : "false") + "}";
      }
      CoTaskMemFree(ids[i]);
    }
    if (json) *json = "[" + arr + "]";
    return out;
  }

  HRESULT open(const std::wstring& id) {
    close();
    auto client = newValues();
    client->SetStringValue(WPD_CLIENT_NAME, L"Mune Player");
    client->SetUnsignedIntegerValue(WPD_CLIENT_MAJOR_VERSION, 1);
    client->SetUnsignedIntegerValue(WPD_CLIENT_MINOR_VERSION, 0);
    client->SetUnsignedIntegerValue(WPD_CLIENT_REVISION, 0);
    client->SetUnsignedIntegerValue(WPD_CLIENT_SECURITY_QUALITY_OF_SERVICE, SECURITY_IMPERSONATION);
    client->SetUnsignedIntegerValue(WPD_CLIENT_DESIRED_ACCESS, GENERIC_READ | GENERIC_WRITE);
    ComPtr<IPortableDevice> d;
    HRESULT hr = CoCreateInstance(CLSID_PortableDeviceFTM, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&d));
    if (FAILED(hr)) return hr;
    hr = d->Open(id.c_str(), client.Get());
    if (FAILED(hr)) return hr;
    dev = d;
    deviceId = id;
    dev->Content(&content);
    content->Properties(&props);
    storageId = firstStorage();
    folderCache.clear();
    return S_OK;
  }

  void close() {
    if (dev) dev->Close();
    props.Reset();
    content.Reset();
    dev.Reset();
    storageId.clear();
    folderCache.clear();
  }

  std::vector<std::wstring> childIds(const std::wstring& parent) {
    std::vector<std::wstring> out;
    ComPtr<IEnumPortableDeviceObjectIDs> en;
    if (FAILED(content->EnumObjects(0, parent.c_str(), nullptr, &en))) return out;
    for (;;) {
      PWSTR ids[64] = {};
      ULONG got = 0;
      HRESULT hr = en->Next(64, ids, &got);
      for (ULONG i = 0; i < got; i++) {
        out.push_back(ids[i]);
        CoTaskMemFree(ids[i]);
      }
      if (hr != S_OK) break;
    }
    return out;
  }

  std::wstring firstStorage() {
    auto keys = newKeys({WPD_FUNCTIONAL_OBJECT_CATEGORY});
    for (auto& id : childIds(WPD_DEVICE_OBJECT_ID)) {
      ComPtr<IPortableDeviceValues> v;
      GUID cat;
      if (SUCCEEDED(props->GetValues(id.c_str(), keys.Get(), &v)) && getGuid(v.Get(), WPD_FUNCTIONAL_OBJECT_CATEGORY, &cat) &&
          IsEqualGUID(cat, WPD_FUNCTIONAL_CATEGORY_STORAGE))
        return id;
    }
    return L"";
  }

  std::string info() {
    auto keys = newKeys({WPD_DEVICE_FRIENDLY_NAME, WPD_DEVICE_MODEL, WPD_DEVICE_MANUFACTURER, WPD_DEVICE_FIRMWARE_VERSION,
                         WPD_DEVICE_SERIAL_NUMBER, WPD_DEVICE_POWER_LEVEL, WPD_DEVICE_POWER_SOURCE});
    ComPtr<IPortableDeviceValues> v;
    std::string o = "{\"deviceId\":" + jstr(deviceId);
    if (SUCCEEDED(props->GetValues(WPD_DEVICE_OBJECT_ID, keys.Get(), &v))) {
      o += ",\"name\":" + jstr(getStr(v.Get(), WPD_DEVICE_FRIENDLY_NAME));
      o += ",\"model\":" + jstr(getStr(v.Get(), WPD_DEVICE_MODEL));
      o += ",\"manufacturer\":" + jstr(getStr(v.Get(), WPD_DEVICE_MANUFACTURER));
      o += ",\"firmware\":" + jstr(getStr(v.Get(), WPD_DEVICE_FIRMWARE_VERSION));
      o += ",\"serial\":" + jstr(getStr(v.Get(), WPD_DEVICE_SERIAL_NUMBER));
      ULONG u;
      if (getU32(v.Get(), WPD_DEVICE_POWER_LEVEL, &u)) o += ",\"battery\":" + std::to_string(u);
      if (getU32(v.Get(), WPD_DEVICE_POWER_SOURCE, &u)) o += ",\"charging\":" + std::string(u == WPD_POWER_SOURCE_EXTERNAL ? "true" : "false");
    }
    if (!storageId.empty()) {
      auto sk = newKeys({WPD_STORAGE_CAPACITY, WPD_STORAGE_FREE_SPACE_IN_BYTES, WPD_STORAGE_DESCRIPTION});
      ComPtr<IPortableDeviceValues> s;
      if (SUCCEEDED(props->GetValues(storageId.c_str(), sk.Get(), &s))) {
        ULONGLONG cap = 0, free = 0;
        getU64(s.Get(), WPD_STORAGE_CAPACITY, &cap);
        getU64(s.Get(), WPD_STORAGE_FREE_SPACE_IN_BYTES, &free);
        o += ",\"storageId\":" + jstr(storageId) + ",\"capacity\":" + std::to_string(cap) + ",\"free\":" + std::to_string(free);
      }
    }
    return o + "}";
  }

  /** All objects of one format, anywhere on the device (including root-level abstract objects). */
  HRESULT byFormat(WORD format, IPortableDeviceKeyCollection* keys, std::vector<ComPtr<IPortableDeviceValues>>& out) {
    ComPtr<IPortableDevicePropertiesBulk> bulk;
    HRESULT hr = props.As(&bulk);
    if (FAILED(hr)) return hr;
    BulkCallback* cb = new BulkCallback();
    GUID ctx = GUID_NULL;
    hr = bulk->QueueGetValuesByObjectFormat(mtpFormat(format), WPD_DEVICE_OBJECT_ID, 0xFFFFFFFF, keys, cb, &ctx);
    if (SUCCEEDED(hr)) hr = bulk->Start(ctx);
    std::vector<ComPtr<IPortableDeviceValues>> rows;
    if (SUCCEEDED(hr)) {
      if (WaitForSingleObject(cb->done, 120000) != WAIT_OBJECT_0) {
        bulk->Cancel(ctx);
        hr = HRESULT_FROM_WIN32(ERROR_TIMEOUT);
      } else {
        hr = cb->status;
        EnterCriticalSection(&cb->cs);
        rows = cb->results;
        LeaveCriticalSection(&cb->cs);
      }
    }
    cb->Release();
    // The Zune driver reports each object's properties spread over several rows;
    // merge them by object id (first non-error value wins).
    std::map<std::wstring, ComPtr<IPortableDeviceValues>> merged;
    std::vector<std::wstring> order;
    for (auto& row : rows) {
      std::wstring oid = wide(getStr(row.Get(), WPD_OBJECT_ID));
      if (oid.empty()) continue;
      auto& target = merged[oid];
      if (!target) {
        target = newValues();
        order.push_back(oid);
      }
      DWORD n = 0;
      row->GetCount(&n);
      for (DWORD i = 0; i < n; i++) {
        PROPERTYKEY k;
        PROPVARIANT pv;
        PropVariantInit(&pv);
        if (SUCCEEDED(row->GetAt(i, &k, &pv)) && pv.vt != VT_ERROR && pv.vt != VT_EMPTY) {
          PROPVARIANT existing;
          PropVariantInit(&existing);
          if (FAILED(target->GetValue(k, &existing)) || existing.vt == VT_ERROR || existing.vt == VT_EMPTY) target->SetValue(k, &pv);
          PropVariantClear(&existing);
        }
        PropVariantClear(&pv);
      }
    }
    for (auto& oid : order) out.push_back(merged[oid]);
    return hr;
  }

  /** References of one object (e.g. an album's tracks), read individually. */
  std::vector<std::wstring> references(const std::wstring& id) {
    auto keys = newKeys({WPD_OBJECT_REFERENCES});
    ComPtr<IPortableDeviceValues> v;
    if (FAILED(props->GetValues(id.c_str(), keys.Get(), &v))) return {};
    return getIdList(v.Get(), WPD_OBJECT_REFERENCES);
  }

  std::string library(std::string* error) {
    auto trackKeys = newKeys({WPD_OBJECT_ID, WPD_OBJECT_PARENT_ID, WPD_OBJECT_PERSISTENT_UNIQUE_ID, WPD_OBJECT_NAME, WPD_OBJECT_ORIGINAL_FILE_NAME,
                              WPD_OBJECT_SIZE, WPD_MEDIA_ARTIST, WPD_MEDIA_ALBUM_ARTIST, WPD_MUSIC_ALBUM, WPD_MUSIC_TRACK, WPD_MEDIA_GENRE,
                              WPD_MEDIA_DURATION, WPD_MEDIA_USE_COUNT, WPD_MEDIA_USER_EFFECTIVE_RATING, mtpProp(PROP_ARTIST_ID), mtpProp(PROP_ALBUM_ID)});
    std::string tracks;
    std::vector<std::wstring> albumIdsSeen;
    const WORD audioFormats[] = {0x3009 /*MP3*/, 0xB901 /*WMA*/, 0xB903 /*AAC*/, 0xB982 /*MP4*/, 0x3008 /*WAV*/};
    for (WORD f : audioFormats) {
      std::vector<ComPtr<IPortableDeviceValues>> rows;
      HRESULT hr = byFormat(f, trackKeys.Get(), rows);
      if (FAILED(hr)) {
        if (error && error->empty()) *error = "tracks " + hexHr(hr);
        continue;
      }
      for (auto& v : rows) {
        ULONGLONG size = 0, dur = 0;
        ULONG track = 0, uses = 0, rating = 0, artistId = 0, albumId = 0;
        getU64(v.Get(), WPD_OBJECT_SIZE, &size);
        getU64(v.Get(), WPD_MEDIA_DURATION, &dur);
        getU32(v.Get(), WPD_MUSIC_TRACK, &track);
        getU32(v.Get(), WPD_MEDIA_USE_COUNT, &uses);
        getU32(v.Get(), WPD_MEDIA_USER_EFFECTIVE_RATING, &rating);
        getU32(v.Get(), mtpProp(PROP_ARTIST_ID), &artistId);
        getU32(v.Get(), mtpProp(PROP_ALBUM_ID), &albumId);
        if (albumId) albumIdsSeen.push_back(idOf(albumId));
        char fmt[8];
        sprintf_s(fmt, "%04X", f);
        if (!tracks.empty()) tracks += ",";
        tracks += "{\"id\":" + jstr(getStr(v.Get(), WPD_OBJECT_ID)) + ",\"parent\":" + jstr(getStr(v.Get(), WPD_OBJECT_PARENT_ID)) +
                  ",\"puid\":" + jstr(getStr(v.Get(), WPD_OBJECT_PERSISTENT_UNIQUE_ID)) + ",\"title\":" + jstr(getStr(v.Get(), WPD_OBJECT_NAME)) +
                  ",\"file\":" + jstr(getStr(v.Get(), WPD_OBJECT_ORIGINAL_FILE_NAME)) + ",\"artist\":" + jstr(getStr(v.Get(), WPD_MEDIA_ARTIST)) +
                  ",\"albumArtist\":" + jstr(getStr(v.Get(), WPD_MEDIA_ALBUM_ARTIST)) + ",\"album\":" + jstr(getStr(v.Get(), WPD_MUSIC_ALBUM)) +
                  ",\"genre\":" + jstr(getStr(v.Get(), WPD_MEDIA_GENRE)) + ",\"track\":" + std::to_string(track) + ",\"durationMs\":" + std::to_string(dur) +
                  ",\"size\":" + std::to_string(size) + ",\"plays\":" + std::to_string(uses) + ",\"rating\":" + std::to_string(rating) +
                  ",\"artistId\":" + jstr(artistId ? idOf(artistId) : L"") + ",\"albumId\":" + jstr(albumId ? idOf(albumId) : L"") +
                  ",\"format\":\"" + fmt + "\"}";
      }
    }

    // Bulk queries for album objects come back empty on the Zune driver, so collect album ids
    // from the tracks (AlbumId) and the Albums folder, then read each album individually.
    auto albumKeys = newKeys({WPD_OBJECT_ID, WPD_OBJECT_PARENT_ID, WPD_OBJECT_NAME, WPD_OBJECT_ORIGINAL_FILE_NAME, WPD_MEDIA_ARTIST,
                              mtpProp(PROP_ARTIST_ID), WPD_OBJECT_FORMAT});
    std::string albums;
    {
      std::vector<std::wstring> ids;
      auto addId = [&](const std::wstring& a) {
        if (!a.empty() && std::find(ids.begin(), ids.end(), a) == ids.end()) ids.push_back(a);
      };
      for (auto& a : albumIdsSeen) addId(a);
      for (auto& root : childIds(storageId)) {
        auto nk = newKeys({WPD_OBJECT_ORIGINAL_FILE_NAME});
        ComPtr<IPortableDeviceValues> nv;
        if (SUCCEEDED(props->GetValues(root.c_str(), nk.Get(), &nv)) && _stricmp(getStr(nv.Get(), WPD_OBJECT_ORIGINAL_FILE_NAME).c_str(), "Albums") == 0)
          for (auto& a : childIds(root)) addId(a);
      }
      std::vector<ComPtr<IPortableDeviceValues>> rows;
      for (auto& a : ids) {
        ComPtr<IPortableDeviceValues> v;
        GUID fmt;
        if (SUCCEEDED(props->GetValues(a.c_str(), albumKeys.Get(), &v)) && getGuid(v.Get(), WPD_OBJECT_FORMAT, &fmt) && mtpFormatCode(fmt) == FMT_ALBUM)
          rows.push_back(v);
      }
      for (auto& v : rows) {
        ULONG artistId = 0;
        getU32(v.Get(), mtpProp(PROP_ARTIST_ID), &artistId);
        std::string refs;
        for (auto& r : references(wide(getStr(v.Get(), WPD_OBJECT_ID)))) refs += (refs.empty() ? "" : ",") + jstr(r);
        if (!albums.empty()) albums += ",";
        albums += "{\"id\":" + jstr(getStr(v.Get(), WPD_OBJECT_ID)) + ",\"parent\":" + jstr(getStr(v.Get(), WPD_OBJECT_PARENT_ID)) +
                  ",\"name\":" + jstr(getStr(v.Get(), WPD_OBJECT_NAME)) + ",\"file\":" + jstr(getStr(v.Get(), WPD_OBJECT_ORIGINAL_FILE_NAME)) +
                  ",\"artist\":" + jstr(getStr(v.Get(), WPD_MEDIA_ARTIST)) + ",\"artistId\":" + jstr(artistId ? idOf(artistId) : L"") +
                  ",\"refs\":[" + refs + "]}";
      }
    }

    auto artistKeys = newKeys({WPD_OBJECT_ID, WPD_OBJECT_PARENT_ID, WPD_OBJECT_NAME, WPD_OBJECT_ORIGINAL_FILE_NAME});
    std::string artists;
    {
      std::vector<ComPtr<IPortableDeviceValues>> rows;
      HRESULT hr = byFormat(FMT_ARTIST, artistKeys.Get(), rows);
      if (FAILED(hr) && error && error->empty()) *error = "artists " + hexHr(hr);
      for (auto& v : rows) {
        if (!artists.empty()) artists += ",";
        artists += "{\"id\":" + jstr(getStr(v.Get(), WPD_OBJECT_ID)) + ",\"parent\":" + jstr(getStr(v.Get(), WPD_OBJECT_PARENT_ID)) +
                   ",\"name\":" + jstr(getStr(v.Get(), WPD_OBJECT_NAME)) + ",\"file\":" + jstr(getStr(v.Get(), WPD_OBJECT_ORIGINAL_FILE_NAME)) + "}";
      }
    }

    auto plKeys = newKeys({WPD_OBJECT_ID, WPD_OBJECT_PARENT_ID, WPD_OBJECT_NAME, WPD_OBJECT_ORIGINAL_FILE_NAME});
    std::string playlists;
    {
      std::vector<ComPtr<IPortableDeviceValues>> rows;
      byFormat(FMT_PLAYLIST, plKeys.Get(), rows);
      for (auto& v : rows) {
        std::string refs;
        for (auto& r : references(wide(getStr(v.Get(), WPD_OBJECT_ID)))) refs += (refs.empty() ? "" : ",") + jstr(r);
        if (!playlists.empty()) playlists += ",";
        playlists += "{\"id\":" + jstr(getStr(v.Get(), WPD_OBJECT_ID)) + ",\"parent\":" + jstr(getStr(v.Get(), WPD_OBJECT_PARENT_ID)) +
                     ",\"name\":" + jstr(getStr(v.Get(), WPD_OBJECT_NAME)) + ",\"file\":" + jstr(getStr(v.Get(), WPD_OBJECT_ORIGINAL_FILE_NAME)) +
                     ",\"refs\":[" + refs + "]}";
      }
    }
    return "\"tracks\":[" + tracks + "],\"albums\":[" + albums + "],\"artists\":[" + artists + "],\"playlists\":[" + playlists + "]";
  }

  /** Find or create a chain of folders under the storage root, e.g. Music\Queen\Greatest Hits. */
  HRESULT ensureFolder(const std::vector<std::wstring>& path, std::wstring& outId) {
    std::wstring parent = storageId;
    std::wstring key;
    auto nameKeys = newKeys({WPD_OBJECT_ORIGINAL_FILE_NAME, WPD_OBJECT_NAME, WPD_OBJECT_CONTENT_TYPE});
    for (auto& part : path) {
      key += L"|" + part;
      auto hit = folderCache.find(key);
      if (hit != folderCache.end()) {
        parent = hit->second;
        continue;
      }
      std::wstring found;
      for (auto& child : childIds(parent)) {
        ComPtr<IPortableDeviceValues> v;
        GUID type;
        if (FAILED(props->GetValues(child.c_str(), nameKeys.Get(), &v))) continue;
        if (!getGuid(v.Get(), WPD_OBJECT_CONTENT_TYPE, &type) || !IsEqualGUID(type, WPD_CONTENT_TYPE_FOLDER)) continue;
        std::wstring n = wide(getStr(v.Get(), WPD_OBJECT_ORIGINAL_FILE_NAME));
        if (n.empty()) n = wide(getStr(v.Get(), WPD_OBJECT_NAME));
        if (_wcsicmp(n.c_str(), part.c_str()) == 0) {
          found = child;
          break;
        }
      }
      if (found.empty()) {
        auto v = newValues();
        v->SetStringValue(WPD_OBJECT_PARENT_ID, parent.c_str());
        v->SetStringValue(WPD_OBJECT_NAME, part.c_str());
        v->SetStringValue(WPD_OBJECT_ORIGINAL_FILE_NAME, part.c_str());
        v->SetGuidValue(WPD_OBJECT_CONTENT_TYPE, WPD_CONTENT_TYPE_FOLDER);
        v->SetGuidValue(WPD_OBJECT_FORMAT, WPD_OBJECT_FORMAT_PROPERTIES_ONLY);
        PWSTR newId = nullptr;
        HRESULT hr = content->CreateObjectWithPropertiesOnly(v.Get(), &newId);
        if (FAILED(hr)) return hr;
        found = newId;
        CoTaskMemFree(newId);
      }
      folderCache[key] = found;
      parent = found;
    }
    outId = parent;
    return S_OK;
  }

  /** Stream a file into a new object. `progress` is called with bytes sent. */
  template <typename F>
  HRESULT createWithData(IPortableDeviceValues* v, const std::wstring& file, std::wstring& newId, F progress) {
    HANDLE h = CreateFileW(file.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
    if (h == INVALID_HANDLE_VALUE) return HRESULT_FROM_WIN32(GetLastError());
    LARGE_INTEGER size;
    GetFileSizeEx(h, &size);
    v->SetUnsignedLargeIntegerValue(WPD_OBJECT_SIZE, (ULONGLONG)size.QuadPart);
    ComPtr<IStream> stream;
    DWORD optimal = 0;
    HRESULT hr = content->CreateObjectWithPropertiesAndData(v, &stream, &optimal, nullptr);
    if (FAILED(hr)) {
      CloseHandle(h);
      return hr;
    }
    std::vector<BYTE> buf(optimal >= 16384 ? optimal : 262144);
    ULONGLONG sent = 0;
    DWORD got = 0;
    ULONGLONG lastReport = 0;
    while (ReadFile(h, buf.data(), (DWORD)buf.size(), &got, nullptr) && got > 0) {
      ULONG written = 0;
      hr = stream->Write(buf.data(), got, &written);
      if (FAILED(hr)) break;
      sent += written;
      if (sent - lastReport >= 1048576 || sent == (ULONGLONG)size.QuadPart) {
        lastReport = sent;
        progress(sent, (ULONGLONG)size.QuadPart);
      }
    }
    CloseHandle(h);
    if (FAILED(hr)) {
      stream->Revert();
      return hr;
    }
    hr = stream->Commit(STGC_DEFAULT);
    if (FAILED(hr)) return hr;
    ComPtr<IPortableDeviceDataStream> ds;
    if (SUCCEEDED(stream.As(&ds))) {
      PWSTR id = nullptr;
      if (SUCCEEDED(ds->GetObjectID(&id)) && id) {
        newId = id;
        CoTaskMemFree(id);
      }
    }
    return S_OK;
  }

  /** Abstract objects (artists, albums, playlists) carry no data; create them properties-only. */
  HRESULT createAbstract(IPortableDeviceValues* v, std::wstring& newId) {
    PWSTR id = nullptr;
    HRESULT hr = content->CreateObjectWithPropertiesOnly(v, &id);
    if (FAILED(hr)) {
      // Some drivers insist on a (zero-length) data phase for these formats.
      v->SetUnsignedLargeIntegerValue(WPD_OBJECT_SIZE, 0);
      ComPtr<IStream> stream;
      DWORD optimal = 0;
      hr = content->CreateObjectWithPropertiesAndData(v, &stream, &optimal, nullptr);
      if (FAILED(hr)) return hr;
      hr = stream->Commit(STGC_DEFAULT);
      if (FAILED(hr)) return hr;
      ComPtr<IPortableDeviceDataStream> ds;
      if (SUCCEEDED(stream.As(&ds)) && SUCCEEDED(ds->GetObjectID(&id)) && id) {
        newId = id;
        CoTaskMemFree(id);
      }
      return S_OK;
    }
    newId = id;
    CoTaskMemFree(id);
    return S_OK;
  }

  HRESULT setValues(const std::wstring& id, IPortableDeviceValues* v, std::string* detail) {
    ComPtr<IPortableDeviceValues> results;
    HRESULT hr = props->SetValues(id.c_str(), v, &results);
    if (results && detail) {
      DWORD n = 0;
      results->GetCount(&n);
      for (DWORD i = 0; i < n; i++) {
        PROPERTYKEY k;
        PROPVARIANT pv;
        PropVariantInit(&pv);
        if (SUCCEEDED(results->GetAt(i, &k, &pv)) && pv.vt == VT_ERROR && FAILED(pv.scode)) {
          char b[64];
          sprintf_s(b, "%s%lu=%s", detail->empty() ? "" : ",", (unsigned long)k.pid, hexHr(pv.scode).c_str());
          *detail += b;
        }
        PropVariantClear(&pv);
      }
    }
    return hr;
  }

  HRESULT writeAlbumArt(const std::wstring& id, const std::wstring& file) {
    HANDLE h = CreateFileW(file.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
    if (h == INVALID_HANDLE_VALUE) return HRESULT_FROM_WIN32(GetLastError());
    LARGE_INTEGER size;
    GetFileSizeEx(h, &size);
    std::vector<BYTE> data((size_t)size.QuadPart);
    DWORD got = 0;
    ReadFile(h, data.data(), (DWORD)data.size(), &got, nullptr);
    CloseHandle(h);
    ComPtr<IPortableDeviceResources> res;
    HRESULT hr = content->Transfer(&res);
    if (SUCCEEDED(hr)) {
      auto attrs = newValues();
      attrs->SetStringValue(WPD_OBJECT_ID, id.c_str());
      attrs->SetKeyValue(WPD_RESOURCE_ATTRIBUTE_RESOURCE_KEY, WPD_RESOURCE_ALBUM_ART);
      attrs->SetUnsignedLargeIntegerValue(WPD_RESOURCE_ATTRIBUTE_TOTAL_SIZE, data.size());
      attrs->SetGuidValue(WPD_RESOURCE_ATTRIBUTE_FORMAT, WPD_OBJECT_FORMAT_JFIF);
      ComPtr<IStream> stream;
      DWORD optimal = 0;
      hr = res->CreateResource(attrs.Get(), &stream, &optimal, nullptr);
      if (SUCCEEDED(hr)) {
        ULONG written = 0;
        hr = stream->Write(data.data(), (ULONG)data.size(), &written);
        if (SUCCEEDED(hr)) hr = stream->Commit(STGC_DEFAULT);
      }
    }
    if (SUCCEEDED(hr)) return hr;
    // Fall back to the raw MTP properties the Zune reads (RepresentativeSample*).
    auto v = newValues();
    v->SetBufferValue(mtpProp(0xDC86), data.data(), (DWORD)data.size());
    v->SetUnsignedIntegerValue(mtpProp(0xDC81), 0x3801);
    v->SetUnsignedIntegerValue(mtpProp(0xDC82), (ULONG)data.size());
    return setValues(id, v.Get(), nullptr);
  }

  // ---- raw MTP operations through the driver's pass-through (used for the MTPZ handshake)
  HRESULT sendMtp(REFPROPERTYKEY command, IPortableDeviceValues* params, ComPtr<IPortableDeviceValues>& results) {
    params->SetGuidValue(WPD_PROPERTY_COMMON_COMMAND_CATEGORY, command.fmtid);
    params->SetUnsignedIntegerValue(WPD_PROPERTY_COMMON_COMMAND_ID, command.pid);
    HRESULT hr = dev->SendCommand(0, params, &results);
    if (FAILED(hr)) return hr;
    HRESULT inner = S_OK;
    if (SUCCEEDED(results->GetErrorValue(WPD_PROPERTY_COMMON_HRESULT, &inner)) && FAILED(inner)) return inner;
    return S_OK;
  }

  /** Runs one MTP operation. dataOut != null -> data phase to the device; wantData -> data phase from it. */
  HRESULT mtpOp(WORD opcode, const std::vector<ULONG>& opParams, const std::vector<BYTE>* dataOut, bool wantData,
                ULONG& responseCode, std::vector<ULONG>& responseParams, std::vector<BYTE>& dataIn) {
    ComPtr<IPortableDevicePropVariantCollection> pc;
    CoCreateInstance(CLSID_PortableDevicePropVariantCollection, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&pc));
    pc->ChangeType(VT_UI4);
    for (ULONG p : opParams) {
      PROPVARIANT pv;
      PropVariantInit(&pv);
      pv.vt = VT_UI4;
      pv.ulVal = p;
      pc->Add(&pv);
    }
    auto params = newValues();
    params->SetUnsignedIntegerValue(WPD_PROPERTY_MTP_EXT_OPERATION_CODE, opcode);
    params->SetIPortableDevicePropVariantCollectionValue(WPD_PROPERTY_MTP_EXT_OPERATION_PARAMS, pc.Get());
    ComPtr<IPortableDeviceValues> results;
    HRESULT hr;
    PWSTR context = nullptr;
    if (dataOut) {
      params->SetUnsignedLargeIntegerValue(WPD_PROPERTY_MTP_EXT_TRANSFER_TOTAL_DATA_SIZE, dataOut->size());
      hr = sendMtp(WPD_COMMAND_MTP_EXT_EXECUTE_COMMAND_WITH_DATA_TO_WRITE, params.Get(), results);
      if (FAILED(hr)) return hr;
      if (FAILED(results->GetStringValue(WPD_PROPERTY_MTP_EXT_TRANSFER_CONTEXT, &context))) return E_UNEXPECTED;
      if (!dataOut->empty()) {
        auto w = newValues();
        w->SetStringValue(WPD_PROPERTY_MTP_EXT_TRANSFER_CONTEXT, context);
        w->SetUnsignedLargeIntegerValue(WPD_PROPERTY_MTP_EXT_TRANSFER_NUM_BYTES_TO_WRITE, dataOut->size());
        w->SetBufferValue(WPD_PROPERTY_MTP_EXT_TRANSFER_DATA, const_cast<BYTE*>(dataOut->data()), (DWORD)dataOut->size());
        ComPtr<IPortableDeviceValues> wr;
        hr = sendMtp(WPD_COMMAND_MTP_EXT_WRITE_DATA, w.Get(), wr);
        if (FAILED(hr)) {
          CoTaskMemFree(context);
          return hr;
        }
      }
    } else if (wantData) {
      hr = sendMtp(WPD_COMMAND_MTP_EXT_EXECUTE_COMMAND_WITH_DATA_TO_READ, params.Get(), results);
      if (FAILED(hr)) return hr;
      if (FAILED(results->GetStringValue(WPD_PROPERTY_MTP_EXT_TRANSFER_CONTEXT, &context))) return E_UNEXPECTED;
      ULONGLONG total = 0;
      results->GetUnsignedLargeIntegerValue(WPD_PROPERTY_MTP_EXT_TRANSFER_TOTAL_DATA_SIZE, &total);
      while (dataIn.size() < total) {
        ULONGLONG want = total - dataIn.size();
        if (want > 262144) want = 262144;
        std::vector<BYTE> scratch((size_t)want);
        auto r = newValues();
        r->SetStringValue(WPD_PROPERTY_MTP_EXT_TRANSFER_CONTEXT, context);
        r->SetUnsignedLargeIntegerValue(WPD_PROPERTY_MTP_EXT_TRANSFER_NUM_BYTES_TO_READ, want);
        r->SetBufferValue(WPD_PROPERTY_MTP_EXT_TRANSFER_DATA, scratch.data(), (DWORD)scratch.size());
        ComPtr<IPortableDeviceValues> rr;
        hr = sendMtp(WPD_COMMAND_MTP_EXT_READ_DATA, r.Get(), rr);
        if (FAILED(hr)) break;
        BYTE* buf = nullptr;
        DWORD len = 0;
        if (FAILED(rr->GetBufferValue(WPD_PROPERTY_MTP_EXT_TRANSFER_DATA, &buf, &len)) || len == 0) break;
        ULONGLONG got = len;
        rr->GetUnsignedLargeIntegerValue(WPD_PROPERTY_MTP_EXT_TRANSFER_NUM_BYTES_READ, &got);
        dataIn.insert(dataIn.end(), buf, buf + (size_t)(got < len ? got : len));
        CoTaskMemFree(buf);
      }
    } else {
      hr = sendMtp(WPD_COMMAND_MTP_EXT_EXECUTE_COMMAND_WITHOUT_DATA_PHASE, params.Get(), results);
      if (FAILED(hr)) return hr;
    }
    if (context) {
      auto end = newValues();
      end->SetStringValue(WPD_PROPERTY_MTP_EXT_TRANSFER_CONTEXT, context);
      CoTaskMemFree(context);
      hr = sendMtp(WPD_COMMAND_MTP_EXT_END_DATA_TRANSFER, end.Get(), results);
      if (FAILED(hr)) return hr;
    }
    results->GetUnsignedIntegerValue(WPD_PROPERTY_MTP_EXT_RESPONSE_CODE, &responseCode);
    ComPtr<IPortableDevicePropVariantCollection> rp;
    if (SUCCEEDED(results->GetIPortableDevicePropVariantCollectionValue(WPD_PROPERTY_MTP_EXT_RESPONSE_PARAMS, &rp)) && rp) {
      DWORD n = 0;
      rp->GetCount(&n);
      for (DWORD i = 0; i < n; i++) {
        PROPVARIANT pv;
        PropVariantInit(&pv);
        if (SUCCEEDED(rp->GetAt(i, &pv))) responseParams.push_back(pv.ulVal);
        PropVariantClear(&pv);
      }
    }
    return S_OK;
  }

  HRESULT remove(const std::vector<std::wstring>& ids, std::string* detail) {
    auto coll = newIdCollection(ids);
    ComPtr<IPortableDevicePropVariantCollection> results;
    HRESULT hr = content->Delete(PORTABLE_DEVICE_DELETE_NO_RECURSION, coll.Get(), &results);
    if (results && detail) {
      DWORD n = 0;
      results->GetCount(&n);
      for (DWORD i = 0; i < n; i++) {
        PROPVARIANT pv;
        PropVariantInit(&pv);
        if (SUCCEEDED(results->GetAt(i, &pv)) && pv.vt == VT_ERROR && FAILED(pv.scode))
          *detail += (detail->empty() ? "" : ",") + utf8(ids[i]) + "=" + hexHr(pv.scode);
        PropVariantClear(&pv);
      }
    }
    return hr;
  }
};

// ================================================================== debug dumps (probe / tree / props)
static std::string keyName(const PROPERTYKEY& k) {
  struct Named {
    const PROPERTYKEY* key;
    const char* name;
  };
  static const Named names[] = {
    {&WPD_OBJECT_ID, "OBJECT_ID"}, {&WPD_OBJECT_PARENT_ID, "PARENT_ID"}, {&WPD_OBJECT_NAME, "NAME"}, {&WPD_OBJECT_PERSISTENT_UNIQUE_ID, "PUID"},
    {&WPD_OBJECT_FORMAT, "FORMAT"}, {&WPD_OBJECT_CONTENT_TYPE, "CONTENT_TYPE"}, {&WPD_OBJECT_SIZE, "SIZE"},
    {&WPD_OBJECT_ORIGINAL_FILE_NAME, "ORIGINAL_FILE_NAME"}, {&WPD_OBJECT_REFERENCES, "REFERENCES"}, {&WPD_OBJECT_DATE_AUTHORED, "DATE_AUTHORED"},
    {&WPD_OBJECT_DATE_CREATED, "DATE_CREATED"}, {&WPD_OBJECT_DATE_MODIFIED, "DATE_MODIFIED"}, {&WPD_OBJECT_NON_CONSUMABLE, "NON_CONSUMABLE"},
    {&WPD_OBJECT_IS_DRM_PROTECTED, "IS_DRM_PROTECTED"}, {&WPD_OBJECT_CONTAINER_FUNCTIONAL_OBJECT_ID, "CONTAINER"},
    {&WPD_MEDIA_ARTIST, "MEDIA_ARTIST"}, {&WPD_MEDIA_ALBUM_ARTIST, "MEDIA_ALBUM_ARTIST"}, {&WPD_MEDIA_GENRE, "MEDIA_GENRE"},
    {&WPD_MEDIA_DURATION, "MEDIA_DURATION"}, {&WPD_MEDIA_USE_COUNT, "MEDIA_USE_COUNT"}, {&WPD_MEDIA_USER_EFFECTIVE_RATING, "MEDIA_USER_RATING"},
    {&WPD_MEDIA_RELEASE_DATE, "MEDIA_RELEASE_DATE"}, {&WPD_MEDIA_SAMPLE_RATE, "MEDIA_SAMPLE_RATE"}, {&WPD_MUSIC_ALBUM, "MUSIC_ALBUM"},
    {&WPD_MUSIC_TRACK, "MUSIC_TRACK"}, {&WPD_AUDIO_BITRATE, "AUDIO_BITRATE"}, {&WPD_STORAGE_CAPACITY, "STORAGE_CAPACITY"},
    {&WPD_STORAGE_FREE_SPACE_IN_BYTES, "STORAGE_FREE"},
  };
  for (auto& n : names)
    if (IsEqualPropertyKey(k, *n.key)) return n.name;
  char b[96];
  if (IsEqualGUID(k.fmtid, MTP_VENDOR_PROPS)) {
    sprintf_s(b, "mtp:0x%04X", (unsigned)k.pid);
    return b;
  }
  sprintf_s(b, "%s/%lu", guidStr(k.fmtid).c_str(), (unsigned long)k.pid);
  return b;
}

static std::string variantJson(const PROPVARIANT& pv) {
  char b[80];
  switch (pv.vt) {
    case VT_LPWSTR: return jstr(pv.pwszVal);
    case VT_UI1: return std::to_string(pv.bVal);
    case VT_UI2: return std::to_string(pv.uiVal);
    case VT_UI4: return std::to_string(pv.ulVal);
    case VT_I4: return std::to_string(pv.lVal);
    case VT_UI8: return std::to_string(pv.uhVal.QuadPart);
    case VT_I8: return std::to_string(pv.hVal.QuadPart);
    case VT_BOOL: return pv.boolVal ? "true" : "false";
    case VT_CLSID: {
      int code = mtpFormatCode(*pv.puuid);
      if (code >= 0) {
        sprintf_s(b, "\"fmt:0x%04X\"", code);
        return b;
      }
      return jstr(guidStr(*pv.puuid));
    }
    case VT_DATE: {
      SYSTEMTIME st;
      if (VariantTimeToSystemTime(pv.date, &st)) {
        sprintf_s(b, "\"%04d-%02d-%02d %02d:%02d:%02d\"", st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
        return b;
      }
      return "\"(date)\"";
    }
    case VT_VECTOR | VT_UI1: {
      std::string o = "\"<" + std::to_string(pv.caub.cElems) + " bytes";
      if (pv.caub.cElems <= 16) {
        o += ":";
        for (ULONG i = 0; i < pv.caub.cElems; i++) {
          sprintf_s(b, "%02x", pv.caub.pElems[i]);
          o += b;
        }
      }
      return o + ">\"";
    }
    case VT_ERROR: sprintf_s(b, "\"error %s\"", hexHr(pv.scode).c_str()); return b;
    case VT_UNKNOWN: {
      ComPtr<IPortableDevicePropVariantCollection> coll;
      if (pv.punkVal && SUCCEEDED(pv.punkVal->QueryInterface(IID_PPV_ARGS(&coll)))) {
        DWORD n = 0;
        coll->GetCount(&n);
        std::string o = "[";
        for (DWORD i = 0; i < n; i++) {
          PROPVARIANT item;
          PropVariantInit(&item);
          coll->GetAt(i, &item);
          o += (i ? "," : "") + variantJson(item);
          PropVariantClear(&item);
        }
        return o + "]";
      }
      return "\"(object)\"";
    }
    default: sprintf_s(b, "\"(vt %u)\"", (unsigned)pv.vt); return b;
  }
}

static std::string allProperties(IPortableDeviceProperties* props, PCWSTR id) {
  ComPtr<IPortableDeviceKeyCollection> keys;
  HRESULT hr = props->GetSupportedProperties(id, &keys);
  if (FAILED(hr)) return "{\"error\":" + jstr(hexHr(hr)) + "}";
  ComPtr<IPortableDeviceValues> values;
  hr = props->GetValues(id, keys.Get(), &values);
  if (!values) return "{\"error\":" + jstr(hexHr(hr)) + "}";
  DWORD n = 0;
  values->GetCount(&n);
  std::string o = "{";
  for (DWORD i = 0; i < n; i++) {
    PROPERTYKEY k;
    PROPVARIANT pv;
    PropVariantInit(&pv);
    if (SUCCEEDED(values->GetAt(i, &k, &pv))) o += (i ? "," : "") + jstr(keyName(k)) + ":" + variantJson(pv);
    PropVariantClear(&pv);
  }
  return o + "}";
}

static void dumpTree(Zune& z, const std::wstring& id, int depth, int maxDepth, std::string& out) {
  auto keys = newKeys({WPD_OBJECT_NAME, WPD_OBJECT_ORIGINAL_FILE_NAME, WPD_OBJECT_FORMAT, WPD_OBJECT_SIZE, WPD_MEDIA_ARTIST, WPD_MUSIC_ALBUM});
  for (auto& child : z.childIds(id)) {
    ComPtr<IPortableDeviceValues> v;
    std::string row = "{\"id\":" + jstr(child) + ",\"parent\":" + jstr(id) + ",\"depth\":" + std::to_string(depth);
    if (SUCCEEDED(z.props->GetValues(child.c_str(), keys.Get(), &v))) {
      GUID g;
      if (getGuid(v.Get(), WPD_OBJECT_FORMAT, &g)) {
        char b[16];
        sprintf_s(b, "0x%04X", mtpFormatCode(g));
        row += ",\"format\":\"" + std::string(b) + "\"";
      }
      row += ",\"name\":" + jstr(getStr(v.Get(), WPD_OBJECT_NAME)) + ",\"file\":" + jstr(getStr(v.Get(), WPD_OBJECT_ORIGINAL_FILE_NAME));
    }
    out += (out.empty() ? "" : ",") + row + "}";
    if (depth + 1 < maxDepth) dumpTree(z, child, depth + 1, maxDepth, out);
  }
}

// ================================================================== request handling (serve mode)
static Zune g_zune;

static const char* B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static std::string b64encode(const std::vector<BYTE>& in) {
  std::string out;
  size_t i = 0;
  for (; i + 2 < in.size(); i += 3) {
    unsigned v = (in[i] << 16) | (in[i + 1] << 8) | in[i + 2];
    out += B64[v >> 18];
    out += B64[(v >> 12) & 63];
    out += B64[(v >> 6) & 63];
    out += B64[v & 63];
  }
  if (i + 1 == in.size()) {
    unsigned v = in[i] << 16;
    out += B64[v >> 18];
    out += B64[(v >> 12) & 63];
    out += "==";
  } else if (i + 2 == in.size()) {
    unsigned v = (in[i] << 16) | (in[i + 1] << 8);
    out += B64[v >> 18];
    out += B64[(v >> 12) & 63];
    out += B64[(v >> 6) & 63];
    out += '=';
  }
  return out;
}

static std::vector<BYTE> b64decode(const std::string& in) {
  std::vector<BYTE> out;
  unsigned v = 0;
  int bits = 0;
  for (char c : in) {
    const char* p = strchr(B64, c);
    if (!p || !c) continue;
    v = (v << 6) | (unsigned)(p - B64);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back((BYTE)((v >> bits) & 0xFF));
    }
  }
  return out;
}

static std::vector<std::wstring> wideList(const JVal* arr) {
  std::vector<std::wstring> out;
  if (arr && arr->t == JVal::Arr)
    for (auto& v : arr->a)
      if (v.t == JVal::Str) out.push_back(wide(v.s));
  return out;
}

static std::string fail(const std::string& id, const std::string& msg, HRESULT hr = S_OK) {
  return "{\"id\":" + id + ",\"ok\":false,\"error\":" + jstr(msg) + (hr ? ",\"hr\":" + jstr(hexHr(hr)) : "") + "}";
}

static std::string handle(const JVal& req) {
  std::string id = req.has("id") ? std::to_string((long long)req.num("id")) : "null";
  std::string cmd = req.str("cmd");
  auto ok = [&](const std::string& extra = "") { return "{\"id\":" + id + ",\"ok\":true" + extra + "}"; };
  auto needOpen = [&]() { return g_zune.isOpen(); };

  if (cmd == "ping") return ok();
  if (cmd == "devices") {
    std::string json;
    Zune::list(true, &json);
    return ok(",\"devices\":" + json);
  }
  if (cmd == "open") {
    std::wstring devId = wide(req.str("deviceId"));
    if (devId.empty()) {
      auto list = Zune::list(true, nullptr);
      if (list.empty()) return fail(id, "No Zune is connected");
      devId = list[0].first;
    }
    HRESULT hr = g_zune.open(devId);
    if (FAILED(hr)) return fail(id, hr == E_ACCESSDENIED || hr == HRESULT_FROM_WIN32(ERROR_BUSY) ? "The Zune is in use by another program (close the Zune software)" : "Could not open the Zune", hr);
    return ok(",\"info\":" + g_zune.info());
  }
  if (cmd == "close") {
    g_zune.close();
    return ok();
  }
  if (!needOpen()) return fail(id, "No device open");

  if (cmd == "info") return ok(",\"info\":" + g_zune.info());
  if (cmd == "library") {
    std::string err;
    std::string lib = g_zune.library(&err);
    return ok("," + lib + (err.empty() ? "" : ",\"warning\":" + jstr(err)));
  }
  if (cmd == "ensureFolder") {
    std::wstring folder;
    HRESULT hr = g_zune.ensureFolder(wideList(req.get("path")), folder);
    if (FAILED(hr)) return fail(id, "Could not create folder", hr);
    return ok(",\"objectId\":" + jstr(folder));
  }
  if (cmd == "uploadTrack") {
    std::wstring file = wide(req.str("file"));
    std::vector<std::wstring> folderPath = wideList(req.get("folder"));
    std::wstring parent = g_zune.storageId;
    HRESULT hr = S_OK;
    if (!folderPath.empty()) {
      hr = g_zune.ensureFolder(folderPath, parent);
      if (FAILED(hr)) return fail(id, "Could not create folder", hr);
    }
    auto v = newValues();
    v->SetStringValue(WPD_OBJECT_PARENT_ID, parent.c_str());
    v->SetStringValue(WPD_OBJECT_NAME, wide(req.str("title")).c_str());
    v->SetStringValue(WPD_OBJECT_ORIGINAL_FILE_NAME, wide(req.str("fileName")).c_str());
    v->SetGuidValue(WPD_OBJECT_CONTENT_TYPE, WPD_CONTENT_TYPE_AUDIO);
    v->SetGuidValue(WPD_OBJECT_FORMAT, mtpFormat((WORD)req.num("format", 0x3009)));
    if (req.has("artist")) v->SetStringValue(WPD_MEDIA_ARTIST, wide(req.str("artist")).c_str());
    if (req.has("albumArtist")) v->SetStringValue(WPD_MEDIA_ALBUM_ARTIST, wide(req.str("albumArtist")).c_str());
    if (req.has("album")) v->SetStringValue(WPD_MUSIC_ALBUM, wide(req.str("album")).c_str());
    if (req.has("genre")) v->SetStringValue(WPD_MEDIA_GENRE, wide(req.str("genre")).c_str());
    if (req.has("track")) v->SetUnsignedIntegerValue(WPD_MUSIC_TRACK, (ULONG)req.num("track"));
    if (req.has("durationMs")) v->SetUnsignedLargeIntegerValue(WPD_MEDIA_DURATION, (ULONGLONG)req.num("durationMs"));
    std::wstring newId;
    hr = g_zune.createWithData(v.Get(), file, newId, [&](ULONGLONG sent, ULONGLONG total) {
      emit("{\"event\":\"progress\",\"req\":" + id + ",\"sent\":" + std::to_string(sent) + ",\"total\":" + std::to_string(total) + "}");
    });
    if (FAILED(hr)) return fail(id, "Upload failed", hr);
    return ok(",\"objectId\":" + jstr(newId) + ",\"parent\":" + jstr(parent));
  }
  if (cmd == "createArtist" || cmd == "createAlbum" || cmd == "createPlaylist") {
    std::wstring parent = g_zune.storageId;
    std::vector<std::wstring> folderPath = wideList(req.get("folder"));
    if (!folderPath.empty()) {
      HRESULT hr = g_zune.ensureFolder(folderPath, parent);
      if (FAILED(hr)) return fail(id, "Could not create folder", hr);
    }
    auto v = newValues();
    v->SetStringValue(WPD_OBJECT_PARENT_ID, parent.c_str());
    v->SetStringValue(WPD_OBJECT_NAME, wide(req.str("name")).c_str());
    v->SetStringValue(WPD_OBJECT_ORIGINAL_FILE_NAME, wide(req.str("fileName")).c_str());
    if (cmd == "createArtist") {
      v->SetGuidValue(WPD_OBJECT_FORMAT, mtpFormat(FMT_ARTIST));
      v->SetGuidValue(WPD_OBJECT_CONTENT_TYPE, WPD_CONTENT_TYPE_UNSPECIFIED);
    } else if (cmd == "createAlbum") {
      v->SetGuidValue(WPD_OBJECT_FORMAT, mtpFormat(FMT_ALBUM));
      v->SetGuidValue(WPD_OBJECT_CONTENT_TYPE, WPD_CONTENT_TYPE_AUDIO_ALBUM);
      if (req.has("artist")) v->SetStringValue(WPD_MEDIA_ARTIST, wide(req.str("artist")).c_str());
      if (req.has("year")) {
        SYSTEMTIME st = {};
        st.wYear = (WORD)req.num("year");
        st.wMonth = 1;
        st.wDay = 2;
        DATE d;
        if (SystemTimeToVariantTime(&st, &d)) {
          PROPVARIANT pv;
          PropVariantInit(&pv);
          pv.vt = VT_DATE;
          pv.date = d;
          v->SetValue(WPD_OBJECT_DATE_AUTHORED, &pv);
        }
      }
    } else {
      v->SetGuidValue(WPD_OBJECT_FORMAT, mtpFormat(FMT_PLAYLIST));
      v->SetGuidValue(WPD_OBJECT_CONTENT_TYPE, WPD_CONTENT_TYPE_PLAYLIST);
    }
    auto refs = wideList(req.get("refs"));
    if (!refs.empty()) v->SetIPortableDevicePropVariantCollectionValue(WPD_OBJECT_REFERENCES, newIdCollection(refs).Get());
    std::wstring newId;
    HRESULT hr = g_zune.createAbstract(v.Get(), newId);
    if (FAILED(hr)) return fail(id, "Could not create " + cmd.substr(6), hr);
    return ok(",\"objectId\":" + jstr(newId));
  }
  if (cmd == "setProps") {
    // {objectId, artistId?, albumId?, name?, refs?}
    std::wstring target = wide(req.str("objectId"));
    auto v = newValues();
    if (req.has("artistId")) v->SetUnsignedIntegerValue(mtpProp(PROP_ARTIST_ID), handleOf(wide(req.str("artistId"))));
    if (req.has("albumId")) v->SetUnsignedIntegerValue(mtpProp(PROP_ALBUM_ID), handleOf(wide(req.str("albumId"))));
    if (req.has("name")) v->SetStringValue(WPD_OBJECT_NAME, wide(req.str("name")).c_str());
    if (req.has("refs")) v->SetIPortableDevicePropVariantCollectionValue(WPD_OBJECT_REFERENCES, newIdCollection(wideList(req.get("refs"))).Get());
    std::string detail;
    HRESULT hr = g_zune.setValues(target, v.Get(), &detail);
    if (FAILED(hr) && hr != S_FALSE) return fail(id, "Could not set properties" + (detail.empty() ? "" : " (" + detail + ")"), hr);
    return ok(detail.empty() ? "" : ",\"partial\":" + jstr(detail));
  }
  if (cmd == "setArt") {
    HRESULT hr = g_zune.writeAlbumArt(wide(req.str("objectId")), wide(req.str("file")));
    if (FAILED(hr)) return fail(id, "Could not set album art", hr);
    return ok();
  }
  if (cmd == "delete") {
    std::string detail;
    HRESULT hr = g_zune.remove(wideList(req.get("ids")), &detail);
    if (FAILED(hr) && hr != S_FALSE) return fail(id, "Delete failed" + (detail.empty() ? "" : " (" + detail + ")"), hr);
    return ok(detail.empty() ? "" : ",\"partial\":" + jstr(detail));
  }
  if (cmd == "mtp") {
    // Raw MTP operation: {op, params:[...], data?: base64 (sent to device), read?: true}
    WORD op = (WORD)req.num("op");
    std::vector<ULONG> ps;
    if (auto a = req.get("params"))
      for (auto& v : a->a) ps.push_back((ULONG)(unsigned long long)v.n);
    bool hasOut = req.has("data");
    std::vector<BYTE> out = hasOut ? b64decode(req.str("data")) : std::vector<BYTE>();
    auto rd = req.get("read");
    bool read = rd && rd->t == JVal::Bool && rd->b;
    ULONG rc = 0;
    std::vector<ULONG> rparams;
    std::vector<BYTE> in;
    HRESULT hr = g_zune.mtpOp(op, ps, hasOut ? &out : nullptr, read, rc, rparams, in);
    if (FAILED(hr)) return fail(id, "MTP operation failed", hr);
    std::string p;
    for (auto v : rparams) p += (p.empty() ? "" : ",") + std::to_string(v);
    return ok(",\"responseCode\":" + std::to_string(rc) + ",\"responseParams\":[" + p + "]" + (read ? ",\"data\":\"" + b64encode(in) + "\"" : ""));
  }
  if (cmd == "props") {
    std::string out;
    for (auto& oid : wideList(req.get("ids"))) out += (out.empty() ? "" : ",") + jstr(oid) + ":" + allProperties(g_zune.props.Get(), oid.c_str());
    return ok(",\"objects\":{" + out + "}");
  }
  return fail(id, "Unknown command: " + cmd);
}

static int serve() {
  emit("{\"event\":\"ready\"}");
  std::string line;
  char buf[65536];
  while (fgets(buf, sizeof(buf), stdin)) {
    line += buf;
    if (line.empty() || line.back() != '\n') continue;
    while (!line.empty() && (line.back() == '\n' || line.back() == '\r')) line.pop_back();
    if (line.empty()) continue;
    JParser p{line.c_str(), line.c_str() + line.size()};
    JVal req = p.value();
    line.clear();
    if (!p.ok || req.t != JVal::Obj) {
      emit("{\"id\":null,\"ok\":false,\"error\":\"bad request\"}");
      continue;
    }
    emit(handle(req));
  }
  g_zune.close();
  return 0;
}

int wmain(int argc, wchar_t** argv) {
  InitializeCriticalSection(&g_out);
  SetConsoleOutputCP(CP_UTF8);
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) {
    printf("{\"ok\":false,\"error\":\"CoInitializeEx %s\"}\n", hexHr(hr).c_str());
    return 1;
  }
  std::wstring cmd = argc > 1 ? argv[1] : L"probe";
  if (cmd == L"serve") return serve();

  std::string devicesJson;
  auto list = Zune::list(true, &devicesJson);
  std::string o = "{\"ok\":true,\"devices\":" + devicesJson;
  if (list.empty()) {
    printf("%s,\"zune\":null}\n", o.c_str());
    return 0;
  }
  hr = g_zune.open(list[0].first);
  o += ",\"open\":" + jstr(hexHr(hr));
  if (FAILED(hr)) {
    printf("%s}\n", o.c_str());
    return 0;
  }
  if (cmd == L"props") {
    o += ",\"objects\":{";
    for (int i = 2; i < argc; i++) o += (i > 2 ? "," : "") + jstr(argv[i]) + ":" + allProperties(g_zune.props.Get(), argv[i]);
    o += "}";
  } else if (cmd == L"library") {
    std::string err;
    o += "," + g_zune.library(&err) + (err.empty() ? "" : ",\"warning\":" + jstr(err));
  } else {
    o += ",\"info\":" + g_zune.info();
    std::string tree;
    dumpTree(g_zune, WPD_DEVICE_OBJECT_ID, 0, cmd == L"tree" ? (argc > 2 ? _wtoi(argv[2]) : 6) : 2, tree);
    o += ",\"tree\":[" + tree + "]";
  }
  printf("%s}\n", o.c_str());
  fflush(stdout);
  g_zune.close();
  return 0;
}
