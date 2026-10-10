// Life's synchronous, contained installer decoder launcher.
// The caller pins the decoder and archive with write/delete-denying file handles
// before checking their identities, and retains them through this call. Success
// here means decoder exit 0 and a drained job, never payload verification.
#include "nsis-plugin-api.h"

#include <algorithm>
#include <cwchar>
#include <string>
#include <utility>
#include <vector>

static_assert(sizeof(STARTUPINFOW) == 68);
static_assert(sizeof(STARTUPINFOEXW) == 72);
static_assert(offsetof(STARTUPINFOEXW, lpAttributeList) == 68);
static_assert(sizeof(PROCESS_INFORMATION) == 16);
static_assert(sizeof(JOBOBJECT_BASIC_LIMIT_INFORMATION) == 48);
static_assert(sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION) == 112);
static_assert(offsetof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, ActiveProcesses) == 40);
static_assert(PROC_THREAD_ATTRIBUTE_JOB_LIST == 0x2000d);
static_assert(PROC_THREAD_ATTRIBUTE_HANDLE_LIST == 0x20002);

namespace {
constexpr DWORD kTerminalExit = 77;
constexpr DWORD kMaxPathCharacters = 32768;

struct OwnedHandle {
  HANDLE value = nullptr;
  OwnedHandle() = default;
  OwnedHandle(const OwnedHandle&) = delete;
  OwnedHandle& operator=(const OwnedHandle&) = delete;
  OwnedHandle(OwnedHandle&& other) noexcept : value(std::exchange(other.value, nullptr)) {}
  OwnedHandle& operator=(OwnedHandle&&) = delete;
  ~OwnedHandle() { if (valid()) CloseHandle(value); }
  bool valid() const { return value && value != INVALID_HANDLE_VALUE; }
  bool close() {
    if (!valid()) { value = nullptr; return true; }
    if (!CloseHandle(value)) return false;
    value = nullptr;
    return true;
  }
};

struct Attributes {
  std::vector<unsigned char> storage;
  LPPROC_THREAD_ATTRIBUTE_LIST list = nullptr;
  bool initialized = false;
  ~Attributes() { clear(); }
  void clear() {
    if (initialized) DeleteProcThreadAttributeList(list);
    initialized = false;
    list = nullptr;
  }
  bool create() {
    SIZE_T bytes = 0;
    SetLastError(ERROR_SUCCESS);
    const BOOL first = InitializeProcThreadAttributeList(nullptr, 2, 0, &bytes);
    const DWORD error = GetLastError();
    if (first || error != ERROR_INSUFFICIENT_BUFFER || !bytes || bytes > 65536) return false;
    storage.resize(bytes);
    list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
    if (!InitializeProcThreadAttributeList(list, 2, 0, &bytes)) return false;
    initialized = true;
    return true;
  }
};

bool absolute_path(const std::wstring& source, std::wstring& result) {
  if (source.size() < 3 || source.size() >= kMaxPathCharacters ||
      !((source[0] >= L'A' && source[0] <= L'Z') || (source[0] >= L'a' && source[0] <= L'z')) ||
      source[1] != L':' || source[2] != L'\\') return false;
  for (size_t i = 0; i < source.size(); ++i) {
    const wchar_t c = source[i];
    if (c < 32 || c == L'"' || c == L'/' || (c == L':' && i != 1)) return false;
  }
  std::vector<wchar_t> buffer(kMaxPathCharacters);
  const DWORD length = GetFullPathNameW(source.c_str(), kMaxPathCharacters, buffer.data(), nullptr);
  if (!length || length >= kMaxPathCharacters || buffer[length] != L'\0') return false;
  result.assign(buffer.data(), length);
  while (result.size() > 3 && result.back() == L'\\') result.pop_back();
  return result.size() >= 3 && result[1] == L':' && result[2] == L'\\';
}

bool ordinary_ancestors(const std::wstring& path, bool directory) {
  for (size_t end = 3; end <= path.size();) {
    const std::wstring part = path.substr(0, end);
    const DWORD attributes = GetFileAttributesW(part.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES ||
        (attributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_ENCRYPTED | FILE_ATTRIBUTE_COMPRESSED)) ||
        (((attributes & FILE_ATTRIBUTE_DIRECTORY) != 0) != (end != path.size() || directory))) return false;
    if (end == path.size()) break;
    const size_t next = path.find(L'\\', end + 1);
    end = next == std::wstring::npos ? path.size() : next;
  }
  return true;
}

bool open_ordinary(const std::wstring& path, bool directory, OwnedHandle& result) {
  result.value = CreateFileW(path.c_str(), directory ? FILE_READ_ATTRIBUTES : GENERIC_READ,
      FILE_SHARE_READ, nullptr, OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), nullptr);
  if (!result.valid()) return false;
  BY_HANDLE_FILE_INFORMATION information{};
  if (!GetFileInformationByHandle(result.value, &information)) return false;
  const DWORD attributes = information.dwFileAttributes;
  return !(attributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_ENCRYPTED | FILE_ATTRIBUTE_COMPRESSED)) &&
      (((attributes & FILE_ATTRIBUTE_DIRECTORY) != 0) == directory);
}

bool pin_ancestors(const std::wstring& path, bool directory, std::vector<OwnedHandle>& pins) {
  // Traverse top-down while earlier components stay write/delete-denying. Open
  // each component itself without following a reparse point, then inspect the
  // held object before resolving the next component. Leaf files are held below.
  for (size_t end = 3; end <= path.size();) {
    if (end == path.size() && !directory) break;
    pins.emplace_back();
    if (!open_ordinary(path.substr(0, end), true, pins.back())) return false;
    if (end == path.size()) break;
    const size_t next = path.find(L'\\', end + 1);
    end = next == std::wstring::npos ? path.size() : next;
  }
  return true;
}

// Standard Windows argv quoting, including trailing backslashes before a quote.
std::wstring quote(const std::wstring& argument) {
  std::wstring result(1, L'"');
  size_t slashes = 0;
  for (wchar_t c : argument) {
    if (c == L'\\') { ++slashes; continue; }
    result.append(slashes * (c == L'"' ? 2 : 1), L'\\');
    slashes = 0;
    if (c == L'"') result.push_back(L'\\');
    result.push_back(c);
  }
  result.append(slashes * 2, L'\\');
  result.push_back(L'"');
  return result;
}

// No return to NSIS, output deletion, recovery, or app launch is permitted if a
// successfully created process/job cannot be positively proved stopped.
[[noreturn]] void terminal_failure(HANDLE job) noexcept {
  if (job && job != INVALID_HANDLE_VALUE) TerminateJobObject(job, kTerminalExit);
  // Self termination lets the kernel close the sole job handle without DLL
  // detach callbacks, which can deadlock if another installer thread holds a
  // loader/CRT lock. The fallback remains nonreturning and requests kill again.
  TerminateProcess(GetCurrentProcess(), kTerminalExit);
  if (job && job != INVALID_HANDLE_VALUE) TerminateJobObject(job, kTerminalExit);
  ExitProcess(kTerminalExit);
}

struct Child {
  OwnedHandle job;
  OwnedHandle process;
  OwnedHandle thread;
  bool launched = false;
  bool drained = false;
  bool membership = false;
#ifdef LIFE_LAUNCHER_FIXTURE_ONLY
  bool force_accounting_failure = false;
#endif
  ~Child() { if (launched && !drained) terminal_failure(job.value); }

  bool accounting(DWORD& active) const {
#ifdef LIFE_LAUNCHER_FIXTURE_ONLY
    if (force_accounting_failure) return false;
#endif
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info{};
    DWORD returned = 0;
    if (!QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation,
        &info, sizeof(info), &returned) || returned != sizeof(info)) return false;
    active = info.ActiveProcesses;
    return true;
  }

  void terminate_and_drain() noexcept {
    // Membership uncertainty is handled before ResumeThread: also terminate the
    // owned suspended process directly rather than assuming the job contains it.
    if (!membership && !TerminateProcess(process.value, kTerminalExit)) {
      if (WaitForSingleObject(process.value, 0) != WAIT_OBJECT_0) terminal_failure(job.value);
    }
    if (!TerminateJobObject(job.value, kTerminalExit)) {
      DWORD active = 0;
      if (!accounting(active) || active != 0) terminal_failure(job.value);
    }
    if (WaitForSingleObject(process.value, INFINITE) != WAIT_OBJECT_0) terminal_failure(job.value);
    for (;;) {
      DWORD active = 0;
      if (!accounting(active)) terminal_failure(job.value);
      if (!active) { drained = true; return; }
      Sleep(1);
    }
  }

  bool close() {
    // Attempt each owned close even if an earlier one fails.
    bool good = thread.close();
    good = process.close() && good;
    good = job.close() && good;
    return good;
  }
};

#ifdef LIFE_LAUNCHER_FIXTURE_ONLY
struct Fixture {
  std::wstring marker;
  std::wstring mode;
};

bool fixture_created(const Fixture* fixture, DWORD pid) {
  if (!fixture) return true;
  std::wstring path;
  if (!absolute_path(fixture->marker, path)) return false;
  OwnedHandle marker;
  marker.value = CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_NEW,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (!marker.valid()) return false;
  wchar_t text[64]{};
  const int length = swprintf_s(text, L"created\t%lu\r\n", static_cast<unsigned long>(pid));
  DWORD written = 0;
  const DWORD bytes = static_cast<DWORD>(length > 0 ? length * sizeof(wchar_t) : 0);
  const bool good = bytes && WriteFile(marker.value, text, bytes, &written, nullptr) && written == bytes &&
      FlushFileBuffers(marker.value);
  if (!marker.close() || !good) return false;
  if (fixture->mode == L"pause-after-create") Sleep(INFINITE);
  return fixture->mode == L"fail-job-query";
}
#endif

const wchar_t* run(const std::wstring& input_exe, const std::wstring& input_archive,
    const std::wstring& input_output
#ifdef LIFE_LAUNCHER_FIXTURE_ONLY
    , const Fixture* fixture
#endif
) {
  std::wstring exe, archive, output;
  if (!absolute_path(input_exe, exe) || !absolute_path(input_archive, archive) ||
      !absolute_path(input_output, output) || output.size() == 3 || !ordinary_ancestors(exe, false) ||
      !ordinary_ancestors(archive, false) || !ordinary_ancestors(output, true)) return L"unavailable";
  const size_t parent_end = exe.rfind(L'\\');
  if (parent_end == std::wstring::npos) return L"unavailable";
  const std::wstring cwd = parent_end == 2 ? exe.substr(0, 3) : exe.substr(0, parent_end);
  if (_wcsicmp(cwd.c_str(), output.c_str()) == 0 ||
      (cwd.size() > output.size() && cwd[output.size()] == L'\\' &&
       _wcsnicmp(cwd.c_str(), output.c_str(), output.size()) == 0)) return L"unavailable";
  std::wstring command = quote(exe) + L" x -t7z -y -aoa -bd -bb0 -bso0 -bse0 -bsp0 " +
      quote(L"-o" + output) + L" -- " + quote(archive);
  if (command.size() >= kMaxPathCharacters) return L"unavailable";

  OwnedHandle exe_file, archive_file, output_directory, null_io;
  std::vector<OwnedHandle> ancestor_pins;
  Child child;
  Attributes attributes;
  const wchar_t* result = L"unavailable";
  // All allocations and throwing string work precede successful CreateProcess.
  auto operation = [&]() {
    if (!pin_ancestors(exe, false, ancestor_pins) || !pin_ancestors(archive, false, ancestor_pins) ||
        !pin_ancestors(output, true, ancestor_pins) ||
        !open_ordinary(exe, false, exe_file) || !open_ordinary(archive, false, archive_file) ||
        !open_ordinary(output, true, output_directory)) return;
    child.job.value = CreateJobObjectW(nullptr, nullptr);
    if (!child.job.valid()) return;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(child.job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) return;
    DWORD flags = 0;
    if (!GetHandleInformation(child.job.value, &flags) || (flags & HANDLE_FLAG_INHERIT)) return;
    SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    null_io.value = CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
        &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (!null_io.valid() || !GetHandleInformation(null_io.value, &flags) || !(flags & HANDLE_FLAG_INHERIT)) return;
    if (!attributes.create()) return;
    // These values remain alive through attribute-list deletion below.
    HANDLE jobs[] = {child.job.value};
    HANDLE inherited[] = {null_io.value};
    if (!UpdateProcThreadAttribute(attributes.list, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
        jobs, sizeof(jobs), nullptr, nullptr) ||
        !UpdateProcThreadAttribute(attributes.list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        inherited, sizeof(inherited), nullptr, nullptr)) { attributes.clear(); return; }
    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = null_io.value;
    startup.StartupInfo.hStdOutput = null_io.value;
    startup.StartupInfo.hStdError = null_io.value;
    startup.lpAttributeList = attributes.list;
    PROCESS_INFORMATION process{};
    // JOB_LIST assigns atomically inside CreateProcess, closing the suspended
    // orphan window of CreateProcess followed by AssignProcessToJobObject.
    const BOOL created = CreateProcessW(exe.c_str(), command.data(), nullptr, nullptr, TRUE,
        CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, nullptr, cwd.c_str(),
        &startup.StartupInfo, &process);
    attributes.clear();
    if (!created) return;
    child.launched = true;
    child.process.value = process.hProcess;
    child.thread.value = process.hThread;
    result = L"error";
    BOOL in_job = FALSE;
    if (!child.process.valid() || !child.thread.valid() ||
        !IsProcessInJob(child.process.value, child.job.value, &in_job) || !in_job) {
      child.terminate_and_drain(); return;
    }
    child.membership = true;
#ifdef LIFE_LAUNCHER_FIXTURE_ONLY
    if (fixture && !fixture_created(fixture, process.dwProcessId)) { child.terminate_and_drain(); return; }
#endif
    if (ResumeThread(child.thread.value) != 1) { child.terminate_and_drain(); return; }
#ifdef LIFE_LAUNCHER_FIXTURE_ONLY
    child.force_accounting_failure = fixture && fixture->mode == L"fail-job-query";
#endif
    if (WaitForSingleObject(child.process.value, INFINITE) != WAIT_OBJECT_0) {
      child.terminate_and_drain(); return;
    }
    DWORD exit_code = STILL_ACTIVE;
    DWORD active = 0;
    if (!GetExitCodeProcess(child.process.value, &exit_code) || exit_code != 0 ||
        !child.accounting(active) || active != 0) { child.terminate_and_drain(); return; }
    child.drained = true;
    result = L"ok";
  };
  try { operation(); }
  catch (...) {
    if (child.launched) { child.terminate_and_drain(); result = L"error"; }
  }
  attributes.clear();
  bool cleaned = child.close();
  cleaned = null_io.close() && cleaned;
  cleaned = output_directory.close() && cleaned;
  cleaned = archive_file.close() && cleaned;
  cleaned = exe_file.close() && cleaned;
  for (auto pin = ancestor_pins.rbegin(); pin != ancestor_pins.rend(); ++pin) cleaned = pin->close() && cleaned;
  return cleaned ? result : L"error";
}

bool bounded_copy(const NsisStack* node, int string_size, std::wstring& result) {
  const size_t capacity = static_cast<size_t>(string_size);
  size_t length = 0;
  while (length < capacity && node->text[length]) ++length;
  if (length == capacity || length >= kMaxPathCharacters) return false;
  result.assign(node->text, length);
  return true;
}

void invoke(int string_size, NsisStack** stacktop, bool fixture_mode) noexcept {
  const size_t count = fixture_mode ? 5 : 3;
  if (!stacktop || string_size < 16 || string_size > 65536) terminal_failure(nullptr);
  NsisStack* nodes[5]{};
  NsisStack* next = *stacktop;
  for (size_t i = 0; i < count; ++i) {
    if (!next) terminal_failure(nullptr); // Invalid caller ABI, no stack speculation.
    nodes[i] = next;
    next = next->next;
  }
  const wchar_t* result = L"unavailable";
  try {
    std::wstring exe, archive, output;
    bool valid = bounded_copy(nodes[0], string_size, exe) && bounded_copy(nodes[1], string_size, archive) &&
        bounded_copy(nodes[2], string_size, output);
#ifdef LIFE_LAUNCHER_FIXTURE_ONLY
    Fixture fixture;
    if (fixture_mode) valid = valid && bounded_copy(nodes[3], string_size, fixture.marker) &&
        bounded_copy(nodes[4], string_size, fixture.mode) &&
        (fixture.mode == L"pause-after-create" || fixture.mode == L"fail-job-query");
    if (valid) result = run(exe, archive, output, fixture_mode ? &fixture : nullptr);
#else
    if (valid) result = run(exe, archive, output);
#endif
  } catch (...) { result = L"unavailable"; }
  // Reuse one caller-owned input allocation, so reporting does not allocate or
  // consume a caller sentinel when memory is exhausted. No registers/flags used.
  for (size_t i = 1; i < count; ++i) if (GlobalFree(nodes[i]) != nullptr) result = L"error";
  if (wcscpy_s(nodes[0]->text, static_cast<size_t>(string_size), result) != 0) terminal_failure(nullptr);
  nodes[0]->next = next;
  *stacktop = nodes[0];
}
} // namespace

extern "C" void __cdecl Launch(HWND, int string_size, wchar_t*, NsisStack** stacktop, NsisExtraParameters*) {
  invoke(string_size, stacktop, false);
}

#ifdef LIFE_LAUNCHER_FIXTURE_ONLY
extern "C" void __cdecl LaunchFixture(
    HWND, int string_size, wchar_t*, NsisStack** stacktop, NsisExtraParameters*) {
  invoke(string_size, stacktop, true);
}
#endif
