$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$configPath = $env:LIFE_MODERN_SMOKE_CONFIG
if (-not $configPath) { throw 'Missing owned smoke configuration' }
$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ([IntPtr]::Size -ne 4) { throw 'The launcher smoke host must be x86 Windows PowerShell' }

$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public sealed class LifeSmokeResult {
  public string token;
  public bool stackContract;
  public bool variablesUnchanged;
  public bool flagsUnchanged;
  public bool checkedCleanup;
  public string error;
  public string contract = "Synthetic Unicode x86 plugin host; this is not a real NSIS state fixture";
}

public static class LifeSmokeHost {
  const int Capacity = 1024;
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GlobalFree(IntPtr memory);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr LoadLibraryExW(string path, IntPtr file, uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Ansi, ExactSpelling=true, SetLastError=true)]
  static extern IntPtr GetProcAddress(IntPtr module, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FreeLibrary(IntPtr module);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl, CharSet=CharSet.Unicode)]
  delegate void Launcher(IntPtr window, int size, IntPtr variables, ref IntPtr stack, IntPtr extra);

  static IntPtr Allocate(int bytes) {
    IntPtr memory = GlobalAlloc(0x40, new UIntPtr((uint)bytes));
    if (memory == IntPtr.Zero) throw new InvalidOperationException("GlobalAlloc failed: " + Marshal.GetLastWin32Error());
    return memory;
  }
  static void Free(IntPtr memory, List<string> errors) {
    if (memory != IntPtr.Zero && GlobalFree(memory) != IntPtr.Zero)
      errors.Add("GlobalFree failed: " + Marshal.GetLastWin32Error());
  }
  static IntPtr Node(string value, IntPtr next) {
    if (value == null || value.Length >= Capacity) throw new InvalidOperationException("Input exceeds synthetic NSIS string capacity");
    byte[] text = Encoding.Unicode.GetBytes(value + "\0");
    IntPtr node = Allocate(4 + Capacity * 2);
    Marshal.WriteIntPtr(node, next);
    Marshal.Copy(text, 0, IntPtr.Add(node, 4), text.Length);
    return node;
  }
  static string Text(IntPtr node) {
    StringBuilder text = new StringBuilder();
    for (int i = 0; i < Capacity; ++i) {
      ushort value = unchecked((ushort)Marshal.ReadInt16(node, 4 + i * 2));
      if (value == 0) return text.ToString();
      text.Append((char)value);
    }
    throw new InvalidOperationException("Unterminated plugin result");
  }
  static byte[] Snapshot(IntPtr memory, int bytes) {
    byte[] data = new byte[bytes]; Marshal.Copy(memory, data, 0, bytes); return data;
  }
  static bool Same(byte[] left, byte[] right) {
    if (left.Length != right.Length) return false;
    for (int i = 0; i < left.Length; ++i) if (left[i] != right[i]) return false;
    return true;
  }

  public static LifeSmokeResult Run(string dll, string export, string[] inputs) {
    if (IntPtr.Size != 4 || (inputs.Length != 3 && inputs.Length != 5))
      throw new InvalidOperationException("Invalid synthetic plugin ABI");
    LifeSmokeResult result = new LifeSmokeResult();
    IntPtr library = IntPtr.Zero, variables = IntPtr.Zero, flags = IntPtr.Zero, extra = IntPtr.Zero;
    IntPtr bottom = IntPtr.Zero, top = IntPtr.Zero;
    IntPtr[] nodes = new IntPtr[inputs.Length];
    bool entered = false;
    List<string> cleanup = new List<string>();
    try {
      library = LoadLibraryExW(dll, IntPtr.Zero, 0x1100);
      if (library == IntPtr.Zero) throw new InvalidOperationException("LoadLibraryExW failed: " + Marshal.GetLastWin32Error());
      IntPtr address = GetProcAddress(library, export);
      if (address == IntPtr.Zero) throw new InvalidOperationException("GetProcAddress failed: " + Marshal.GetLastWin32Error());
      Launcher launch = (Launcher)Marshal.GetDelegateForFunctionPointer(address, typeof(Launcher));
      variables = Allocate(20 * Capacity * 2);
      byte[] pattern = new byte[20 * Capacity * 2];
      for (int i = 0; i < pattern.Length; ++i) pattern[i] = 0x6d;
      Marshal.Copy(pattern, 0, variables, pattern.Length);
      flags = Allocate(56); Marshal.WriteInt32(flags, 8, 1);
      extra = Allocate(16); Marshal.WriteIntPtr(extra, flags);
      byte[] initialFlags = Snapshot(flags, 56);
      bottom = Node("life-smoke-sentinel-bottom", IntPtr.Zero);
      top = Node("life-smoke-sentinel-top", bottom);
      IntPtr stack = top;
      for (int i = inputs.Length - 1; i >= 0; --i) { nodes[i] = Node(inputs[i], stack); stack = nodes[i]; }
      entered = true;
      launch(IntPtr.Zero, Capacity, variables, ref stack, extra);
      GC.KeepAlive(launch);
      // Inspect only owned known node addresses; a malformed pointer is never dereferenced.
      result.stackContract = stack == nodes[0] && Marshal.ReadIntPtr(nodes[0]) == top &&
          Marshal.ReadIntPtr(top) == bottom && Marshal.ReadIntPtr(bottom) == IntPtr.Zero &&
          Text(top) == "life-smoke-sentinel-top" && Text(bottom) == "life-smoke-sentinel-bottom";
      if (stack == nodes[0]) result.token = Text(stack);
      result.variablesUnchanged = Same(pattern, Snapshot(variables, pattern.Length));
      result.flagsUnchanged = Same(initialFlags, Snapshot(flags, 56));
    } catch (Exception error) { result.error = error.ToString(); }
    finally {
      // Once entered, the plugin owns and consumes inputs 1..N; only its retained
      // result node and the two original sentinel nodes remain ours to free.
      if (entered) Free(nodes[0], cleanup);
      else for (int i = 0; i < nodes.Length; ++i) Free(nodes[i], cleanup);
      Free(top, cleanup); Free(bottom, cleanup);
      Free(extra, cleanup); Free(flags, cleanup); Free(variables, cleanup);
      if (library != IntPtr.Zero && !FreeLibrary(library)) cleanup.Add("FreeLibrary failed: " + Marshal.GetLastWin32Error());
      result.checkedCleanup = cleanup.Count == 0;
      if (cleanup.Count != 0) result.error = (result.error ?? "") + "\n" + String.Join("\n", cleanup.ToArray());
    }
    return result;
  }
}
'@

function Save-AtomicJson($value, [string]$destination) {
  $temporary = $destination + '.pending'
  $text = ConvertTo-Json -InputObject $value -Depth 8
  [IO.File]::WriteAllText($temporary, $text + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
  [IO.File]::Move($temporary, $destination)
}

try {
  Add-Type -TypeDefinition $source -Language CSharp
  $result = [LifeSmokeHost]::Run([string]$config.dll, [string]$config.export, [string[]]$config.inputs)
  Save-AtomicJson $result ([string]$config.report)
  if ($result.error) { exit 3 }
} catch {
  Save-AtomicJson @{ error = $_.Exception.ToString(); hostFailed = $true } ([string]$config.report)
  exit 4
}
