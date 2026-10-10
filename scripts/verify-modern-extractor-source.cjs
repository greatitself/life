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
#include <vector>
using DWORD = unsigned long;
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
struct OwnedHandle { std::wstring path; };
bool open_ordinary(const std::wstring& value, bool directory, OwnedHandle& handle) {
  assert(directory);
  handle.path = value;
  const DWORD attr = GetFileAttributesW(value.c_str());
  return attr != INVALID_FILE_ATTRIBUTES && (attr & 0x4c10) == 0x10;
}
${functionSource('bool pin_ancestors(')}
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
  assert(pin_ancestors(L"D:\\a\\b", true, pins));
  assert((observed == std::vector<std::wstring>{L"D:\\", L"D:\\a", L"D:\\a\\b"}));
  assert(pins.size() == 3 && pins[0].path == L"D:\\" && pins[2].path == L"D:\\a\\b");
  pins.clear(); observed.clear();
  assert(pin_ancestors(L"D:\\f", false, pins));
  assert(observed == std::vector<std::wstring>{L"D:\\"} && pins.size() == 1);
  pins.clear(); observed.clear();
  assert(pin_ancestors(L"D:\\", true, pins));
  assert(observed == std::vector<std::wstring>{L"D:\\"} && pins.size() == 1);
  observed.clear();
  assert(!ordinary_ancestors(L"D:\\a\\b", false));
  for (DWORD unsafe : {0x400UL, 0x800UL, 0x4000UL, 0xffffffffUL}) {
    observed.clear(); attributes[L"D:\\a"] = unsafe;
    assert(!ordinary_ancestors(L"D:\\a\\b", true));
    assert((observed == std::vector<std::wstring>{L"D:\\", L"D:\\a"}));
    pins.clear(); observed.clear();
    assert(!pin_ancestors(L"D:\\a\\b", true, pins));
    assert((observed == std::vector<std::wstring>{L"D:\\", L"D:\\a"}));
  }
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
