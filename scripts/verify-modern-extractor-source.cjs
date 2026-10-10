// Execute the actual launcher's path-boundary and argv functions independently
// of Win32. This catches nonterminating ancestry traversal before native builds;
// real Windows job, loader, filesystem, and NSIS proofs remain mandatory.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const project = path.resolve(__dirname, '..')
const source = fs.readFileSync(path.join(project, 'build/modern-extractor/launcher.cpp'), 'utf8')
function functionSource(signature) {
  const start = source.indexOf(signature)
  if (start < 0) throw new Error(`Missing launcher function ${signature}`)
  const body = source.indexOf('{', start)
  let depth = 1
  let end = body + 1
  while (depth && end < source.length) {
    if (source[end] === '{') depth++
    if (source[end] === '}') depth--
    end++
  }
  if (depth) throw new Error(`Unterminated launcher function ${signature}`)
  return source.slice(start, end)
}

const fixture = String.raw`
#include <cassert>
#include <cwchar>
#include <map>
#include <string>
#include <utility>
#include <vector>
#define LIFE_DIAG_ARGUMENT
using DWORD = unsigned long;
using HANDLE = unsigned long;
constexpr DWORD FILE_ATTRIBUTE_DIRECTORY = 0x10;
constexpr DWORD FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
constexpr DWORD FILE_ATTRIBUTE_ENCRYPTED = 0x4000;
constexpr DWORD FILE_ATTRIBUTE_COMPRESSED = 0x800;
constexpr DWORD INVALID_FILE_ATTRIBUTES = 0xffffffff;
std::map<std::wstring, DWORD> attributes;
std::vector<std::wstring> observed;
DWORD GetFileAttributesW(const wchar_t* input) {
  observed.emplace_back(input);
  assert(observed.size() < 12); // An ancestry loop fails rather than hanging.
  const auto found = attributes.find(input);
  return found == attributes.end() ? INVALID_FILE_ATTRIBUTES : found->second;
}
${functionSource('bool ordinary_ancestors(')}
std::map<HANDLE, std::wstring> handle_paths;
HANDLE next_handle = 1;
struct OwnedHandle {
  HANDLE value = 0;
  OwnedHandle() = default;
  OwnedHandle(const OwnedHandle&) = delete;
  OwnedHandle& operator=(const OwnedHandle&) = delete;
  OwnedHandle(OwnedHandle&& other) noexcept : value(std::exchange(other.value, 0)) {}
};
bool open_ordinary(const std::wstring& value, bool directory, OwnedHandle& handle) {
  assert(directory && value.size() == 3); // Only the drive root uses a pathname.
  const DWORD attr = GetFileAttributesW(value.c_str());
  if (attr == INVALID_FILE_ATTRIBUTES || (attr & 0x4c10) != 0x10) return false;
  handle.value = next_handle++;
  handle_paths[handle.value] = value;
  return true;
}
struct RelativeRequest { HANDLE parent; std::wstring component; bool directory; };
std::vector<RelativeRequest> relative_requests;
struct NativeFiles {
  bool open_relative(HANDLE parent, const std::wstring& component, bool directory, OwnedHandle& result) const {
    assert(parent && handle_paths.count(parent));
    assert(!component.empty() && component.find_first_of(L"\\/:") == std::wstring::npos);
    relative_requests.push_back({parent, component, directory});
    assert(relative_requests.size() < 12);
    const std::wstring& parent_path = handle_paths.at(parent);
    assert(attributes.at(parent_path) == FILE_ATTRIBUTE_DIRECTORY);
    const std::wstring value = parent_path + (parent_path.size() == 3 ? L"" : L"\\") + component;
    const DWORD attr = GetFileAttributesW(value.c_str());
    if (attr == INVALID_FILE_ATTRIBUTES) return false;
    result.value = next_handle++;
    handle_paths[result.value] = value;
    return !(attr & 0x4c00) && (((attr & 0x10) != 0) == directory);
  }
};
${functionSource('bool pin_path(')}
${functionSource('std::wstring quote(')}

// An independent decoder of Windows CRT backslash/quote rules, used only to
// verify generated argv, including quotes and trailing backslashes.
std::vector<std::wstring> parse(const std::wstring& command) {
  std::vector<std::wstring> args;
  size_t p = 0;
  while (p < command.size()) {
    while (p < command.size() && (command[p] == L' ' || command[p] == L'\t')) ++p;
    if (p == command.size()) break;
    bool quoted = false;
    std::wstring arg;
    while (p < command.size() && (quoted || (command[p] != L' ' && command[p] != L'\t'))) {
      size_t slashes = 0;
      while (p < command.size() && command[p] == L'\\') { ++slashes; ++p; }
      if (p < command.size() && command[p] == L'"') {
        arg.append(slashes / 2, L'\\');
        if (slashes % 2) arg.push_back(L'"'); else quoted = !quoted;
        ++p;
      } else {
        arg.append(slashes, L'\\');
        if (p < command.size() && (quoted || (command[p] != L' ' && command[p] != L'\t'))) arg.push_back(command[p++]);
      }
    }
    args.push_back(arg);
  }
  return args;
}
int main() {
  attributes = {{L"D:\\", 0x10}, {L"D:\\a", 0x10}, {L"D:\\a\\b", 0x10}};
  assert(ordinary_ancestors(L"D:\\a\\b", true));
  assert((observed == std::vector<std::wstring>{L"D:\\", L"D:\\a", L"D:\\a\\b"}));
  observed.clear();
  assert(ordinary_ancestors(L"D:\\", true));
  assert(observed == std::vector<std::wstring>{L"D:\\"});
  observed.clear();
  attributes[L"D:\\f"] = 0x20;
  assert(ordinary_ancestors(L"D:\\f", false));
  assert((observed == std::vector<std::wstring>{L"D:\\", L"D:\\f"}));
  observed.clear();
  std::vector<OwnedHandle> pins;
  OwnedHandle leaf;
  const NativeFiles native;
  assert(pin_path(L"D:\\a\\b", true, native, pins, leaf));
  assert((observed == std::vector<std::wstring>{L"D:\\", L"D:\\a", L"D:\\a\\b"}));
  assert(pins.size() == 2 && handle_paths.at(pins[0].value) == L"D:\\" && handle_paths.at(pins[1].value) == L"D:\\a");
  assert(handle_paths.at(leaf.value) == L"D:\\a\\b");
  assert(relative_requests.size() == 2 && relative_requests[0].parent == pins[0].value &&
      relative_requests[0].component == L"a" && relative_requests[0].directory &&
      relative_requests[1].parent == pins[1].value && relative_requests[1].component == L"b" &&
      relative_requests[1].directory);
  pins.clear(); observed.clear(); relative_requests.clear(); leaf.value = 0;
  assert(pin_path(L"D:\\f", false, native, pins, leaf));
  assert((observed == std::vector<std::wstring>{L"D:\\", L"D:\\f"}) && pins.size() == 1);
  assert(relative_requests.size() == 1 && relative_requests[0].parent == pins[0].value &&
      relative_requests[0].component == L"f" && !relative_requests[0].directory);
  assert(handle_paths.at(leaf.value) == L"D:\\f");
  pins.clear(); observed.clear(); relative_requests.clear(); leaf.value = 0;
  assert(!pin_path(L"D:\\", true, native, pins, leaf));
  assert(observed == std::vector<std::wstring>{L"D:\\"} && pins.size() == 1 &&
      relative_requests.empty() && !leaf.value);
  observed.clear();
  assert(!ordinary_ancestors(L"D:\\a\\b", false));
  for (DWORD unsafe : {0x400UL, 0x800UL, 0x4000UL, 0xffffffffUL}) {
    observed.clear(); attributes[L"D:\\a"] = unsafe;
    assert(!ordinary_ancestors(L"D:\\a\\b", true));
    assert((observed == std::vector<std::wstring>{L"D:\\", L"D:\\a"}));
    pins.clear(); observed.clear(); relative_requests.clear(); leaf.value = 0;
    assert(!pin_path(L"D:\\a\\b", true, native, pins, leaf));
    assert((observed == std::vector<std::wstring>{L"D:\\", L"D:\\a"}));
    assert(!leaf.value && relative_requests.size() == 1 && relative_requests[0].parent == pins[0].value);
  }
  attributes[L"D:\\a"] = FILE_ATTRIBUTE_DIRECTORY;
  pins.clear(); observed.clear(); relative_requests.clear(); leaf.value = 0;
  assert(!pin_path(L"D:\\a\\b", false, native, pins, leaf));
  assert(leaf.value && handle_paths.at(leaf.value) == L"D:\\a\\b"); // A failed leaf check still owns its handle.
  const std::vector<std::wstring> expected = {
    L"C:\\private tools\\7za.exe", L"x", L"-t7z", L"-y", L"-aoa", L"-bd", L"-bb0",
    L"-bso0", L"-bse0", L"-bsp0", L"-oC:\\Unicode-\u03bb-$-'\u0060\\target",
    L"--", L"C:\\private tools\\payload-$-'\u0060.7z"
  };
  std::wstring command;
  for (const auto& value : expected) { if (!command.empty()) command += L' '; command += quote(value); }
  assert(parse(command) == expected);
  for (const auto& value : std::vector<std::wstring>{L"", L"abc", L"a b", L"a\"b", L"C:\\a\\", L"\\\\\""}) {
    assert(parse(quote(value)) == std::vector<std::wstring>{value});
  }
}
`

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'life-launcher-source-'))
try {
  const input = path.join(scratch, 'boundary.cpp')
  const output = path.join(scratch, 'boundary')
  fs.writeFileSync(input, fixture)
  execFileSync(process.env.CXX || 'g++', [
    '-std=c++17',
    '-Wall',
    '-Wextra',
    '-Werror',
    input,
    '-o',
    output,
  ])
  execFileSync(output, [], { timeout: 10000 })
  console.log('Launcher ancestry boundaries and independent argv roundtrips passed.')
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}
