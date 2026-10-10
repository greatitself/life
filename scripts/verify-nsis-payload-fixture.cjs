'use strict'

const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { performance } = require('node:perf_hooks')
const { getPath7za } = require('app-builder-lib/out/toolsets/7zip.js')
const { getMakeNsisPath, getNsisPluginsPath } = require('app-builder-lib/out/toolsets/windows.js')

const root = path.resolve(__dirname, '..')

const decoderObserverNative = String.raw`// Fixture proposal only. Never opens or duplicates a job handle.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

public sealed class LifeDecoderObserverOptions {
  public string OwnedRoot, ReadyFile, ParentPidFile, ChildPidFile, ObservedFile, ResultFile, AckFile;
  public string Mode;
  public string KillRequestFile, RequestToken, ParentImage, DecoderRoot;
  public string DecoderSuffix, DecoderSha256, PayloadFile;
  public long ExpectedSize;
  public byte[] Prefix, Tail;
}

public sealed class LifeDecoderObserverResult {
  public bool Success, ParentKilled, CleanupParentKilled, CleanupDecoderKilled, Preallocated, FinalPreallocated;
  public long PartialSize, FinalPartialSize;
  public string FailureKind, Failure, ParentImage, DecoderImage, DecoderSha256;
  public string ParentCreationTime, DecoderCreationTime;
  public uint ParentPid, DecoderPid, ParentWait, DecoderWait, ParentExit, DecoderExit;
  public string[] CleanupFailures;
}

public static class LifeDecoderObserver {
  const uint QuerySync = 0x101000, QuerySyncTerminate = 0x101001;
  const uint Object0 = 0, Timeout = 258, Failed = 0xffffffff;
  static readonly IntPtr Invalid = new IntPtr(-1);
  static readonly Encoding Utf8 = new UTF8Encoding(false);

  [StructLayout(LayoutKind.Sequential)]
  struct FileTime { public uint Low, High; public ulong Value { get { return ((ulong)High << 32) | Low; } } }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct Entry {
    public uint Size, Usage, Pid;
    public IntPtr Heap;
    public uint Module, Threads, Parent;
    public int Priority;
    public uint Flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Name;
  }
  sealed class ProofFailure : Exception {
    public readonly string Kind;
    public ProofFailure(string kind, string message) : base(message) { Kind = kind; }
  }
  [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)] static extern bool GetProcessTimes(IntPtr h, out FileTime c, out FileTime x, out FileTime k, out FileTime u);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)] static extern bool QueryFullProcessImageNameW(IntPtr h, uint flags, StringBuilder text, ref uint size);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  static extern uint GetLongPathNameW(string path, StringBuilder output, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)] static extern bool Process32FirstW(IntPtr h, ref Entry e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)] static extern bool Process32NextW(IntPtr h, ref Entry e);
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)] static extern bool TerminateProcess(IntPtr h, uint exit);
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);

  static Exception Native(string operation) { return new Win32Exception(Marshal.GetLastWin32Error(), operation); }
  static string LongPath(string input) {
    string path = Path.GetFullPath(input);
    if (!File.Exists(path) && !Directory.Exists(path)) {
      string parent = Path.GetDirectoryName(path);
      if (String.IsNullOrEmpty(parent)) throw new ProofFailure("invalid-path", input);
      return Path.Combine(LongPath(parent), Path.GetFileName(path));
    }
    StringBuilder output = new StringBuilder(32768);
    uint n = GetLongPathNameW(path, output, (uint)output.Capacity);
    if (n == 0 || n >= output.Capacity) throw Native("GetLongPathNameW");
    return output.ToString().TrimEnd(Path.DirectorySeparatorChar);
  }
  static bool SamePath(string a, string b) { return String.Equals(LongPath(a), LongPath(b), StringComparison.OrdinalIgnoreCase); }
  static bool Under(string path, string root) { return LongPath(path).StartsWith(LongPath(root) + "\\", StringComparison.OrdinalIgnoreCase); }
  static string Image(IntPtr h) {
    StringBuilder text = new StringBuilder(32768); uint n = (uint)text.Capacity;
    if (!QueryFullProcessImageNameW(h, 0, text, ref n)) throw Native("QueryFullProcessImageNameW");
    return LongPath(text.ToString());
  }
  static ulong Created(IntPtr h) {
    FileTime c, x, k, u;
    if (!GetProcessTimes(h, out c, out x, out k, out u)) throw Native("GetProcessTimes");
    return c.Value;
  }
  static uint Wait(IntPtr h, uint ms, string name) {
    uint value = WaitForSingleObject(h, ms);
    if (value == Failed) throw Native("WaitForSingleObject(" + name + ")");
    if (value != Object0 && value != Timeout) throw new ProofFailure("unexpected-wait", name + ": " + value);
    return value;
  }
  static void Alive(IntPtr h, string name) {
    if (Wait(h, 0, name) != Timeout) throw new ProofFailure(name + "-died", name + " exited before parent termination");
  }
  static string Hash(string filename) {
    using (SHA256 hash = SHA256.Create())
    using (FileStream input = new FileStream(filename, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
      return BitConverter.ToString(hash.ComputeHash(input)).Replace("-", "").ToLowerInvariant();
  }
  static void Close(ref IntPtr h, string name, List<string> failures) {
    if (h == IntPtr.Zero || h == Invalid) return;
    IntPtr value = h; h = IntPtr.Zero;
    if (!CloseHandle(value)) failures.Add(name + ": " + Native("CloseHandle").ToString());
  }
  static List<Entry> Entries() {
    IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
    if (snapshot == Invalid) throw Native("CreateToolhelp32Snapshot");
    Exception primary = null; List<Entry> result = new List<Entry>();
    try {
      Entry e = new Entry(); e.Size = (uint)Marshal.SizeOf(typeof(Entry));
      if (!Process32FirstW(snapshot, ref e)) {
        int error = Marshal.GetLastWin32Error();
        if (error != 18) throw new Win32Exception(error, "Process32FirstW");
      } else {
        while (true) {
          result.Add(e);
          if (result.Count > 65536) throw new ProofFailure("snapshot-bound", "Too many processes");
          if (!Process32NextW(snapshot, ref e)) {
            int error = Marshal.GetLastWin32Error();
            if (error != 18) throw new Win32Exception(error, "Process32NextW");
            break;
          }
        }
      }
    } catch (Exception ex) { primary = ex; }
    if (!CloseHandle(snapshot)) {
      Exception close = Native("CloseHandle(snapshot)");
      if (primary != null) throw new AggregateException(primary, close);
      throw close;
    }
    if (primary != null) throw primary;
    return result;
  }
  static bool IsChild(uint pid, uint parent) {
    foreach (Entry e in Entries()) if (e.Pid == pid) return e.Parent == parent;
    return false;
  }
  static string CompleteControl(string filename) {
    try {
      using (FileStream input = new FileStream(filename, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
        if (input.Length > 4096) throw new ProofFailure("control-bound", filename);
        byte[] bytes = new byte[(int)input.Length]; int read = input.Read(bytes, 0, bytes.Length);
        if (read != bytes.Length) return null;
        string text = Encoding.ASCII.GetString(bytes);
        return text.EndsWith("\r\n", StringComparison.Ordinal) ? text : null;
      }
    } catch (FileNotFoundException) { return null; }
      catch (DirectoryNotFoundException) { return null; }
  }
  static uint Pid(string text, string name) {
    uint value;
    if (!Regex.IsMatch(text ?? "", "^[0-9]+\\r\\n$") || !UInt32.TryParse(text.Trim(), out value) || value == 0)
      throw new ProofFailure("invalid-" + name, "Expected one complete decimal PID");
    return value;
  }
  static void Atomic(string filename, string text) {
    string pending = filename + ".pending-" + GetCurrentProcessId();
    using (FileStream output = new FileStream(pending, FileMode.CreateNew, FileAccess.Write, FileShare.Read)) {
      byte[] bytes = Utf8.GetBytes(text); output.Write(bytes, 0, bytes.Length); output.Flush(true);
    }
    File.Move(pending, filename);
  }
  public static void PublishResult(LifeDecoderObserverOptions o, string text) {
    if (!Under(o.ResultFile, o.OwnedRoot)) throw new ProofFailure("invalid-scope", o.ResultFile);
    Atomic(o.ResultFile, text + "\r\n");
  }
  static string Quote(string text) {
    StringBuilder b = new StringBuilder("\"");
    foreach (char c in text) {
      if (c == '\\' || c == '"') b.Append('\\').Append(c);
      else if (c < 32) b.Append("\\u").Append(((int)c).ToString("x4"));
      else b.Append(c);
    }
    return b.Append('"').ToString();
  }
  static bool Equal(byte[] a, byte[] b) {
    if (a.Length != b.Length) return false;
    for (int i = 0; i < a.Length; ++i) if (a[i] != b[i]) return false;
    return true;
  }
  static bool AnyNonzero(byte[] bytes) { foreach (byte b in bytes) if (b != 0) return true; return false; }
  static byte[] ReadBlock(FileStream input, int size) {
    byte[] output = new byte[size]; int total = 0;
    while (total < size) { int n = input.Read(output, total, size - total); if (n == 0) break; total += n; }
    if (total != size) throw new ProofFailure("partial-evidence-lost", "Expected complete prefix/tail read");
    return output;
  }
  static void Partial(LifeDecoderObserverOptions o, LifeDecoderObserverResult r, bool afterExit) {
    using (FileStream input = new FileStream(o.PayloadFile, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
      long length = input.Length;
      if (length < o.Prefix.Length || length > o.ExpectedSize || !Equal(ReadBlock(input, o.Prefix.Length), o.Prefix))
        throw new ProofFailure("partial-evidence-lost", "Expected exact written prefix in incomplete payload");
      bool preallocated = length == o.ExpectedSize;
      if (preallocated) {
        input.Position = o.ExpectedSize - o.Tail.Length;
        if (AnyNonzero(ReadBlock(input, o.Tail.Length)))
          throw new ProofFailure("partial-evidence-lost", "Preallocated tail was written before native parent termination");
      }
      // Writes may finish between the pre-termination read and owner kill.
      // Both observations independently prove incomplete trusted content; the
      // controller's no-late-write comparison starts after both handles signal.
      if (afterExit) { r.FinalPartialSize = length; r.FinalPreallocated = preallocated; }
      else { r.PartialSize = length; r.Preallocated = preallocated; }
    }
  }
  static uint MarkerPid(string filename) {
    try {
      byte[] bytes;
      using (FileStream input = new FileStream(filename, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
        if (input.Length > 4096) throw new ProofFailure("invalid-child-marker", "Invalid UTF16LE marker size");
        bytes = new byte[(int)input.Length];
        if (input.Read(bytes, 0, bytes.Length) != bytes.Length || bytes.Length % 2 != 0) return 0;
      }
      string text = new UnicodeEncoding(false, false, true).GetString(bytes);
      if (!text.EndsWith("\r\n", StringComparison.Ordinal)) return 0;
      if (!Regex.IsMatch(text, "^created\\t[0-9]+\\r\\n$"))
        throw new ProofFailure("invalid-child-marker", "Expected exact UTF16LE created-tab-PID record");
      return Pid(text.Substring(8), "child-pid");
    } catch (FileNotFoundException) { return 0; }
      catch (DirectoryNotFoundException) { return 0; }
  }
  static void Validate(LifeDecoderObserverOptions o) {
    if (o.Mode != "PartialKill" && o.Mode != "MarkerKill" && o.Mode != "MarkerExit")
      throw new ProofFailure("invalid-config", "Expected explicit PartialKill, MarkerKill or MarkerExit mode");
    if (o.Mode == "PartialKill" && (o.Prefix == null || o.Tail == null || o.Prefix.Length != 4096 || o.Tail.Length != 4096 ||
        o.ExpectedSize != 67108864 || !AnyNonzero(o.Prefix) || !AnyNonzero(o.Tail)))
      throw new ProofFailure("invalid-config", "Expected actual 64MiB / 4KiB prefix+tail fixture");
    if (!Regex.IsMatch(o.DecoderSha256 ?? "", "^[0-9a-f]{64}$") || (o.Mode != "MarkerExit" && String.IsNullOrEmpty(o.RequestToken)))
      throw new ProofFailure("invalid-config", "Missing trusted decoder hash or kill token");
    foreach (string path in new string[] { o.ReadyFile, o.ParentPidFile, o.ObservedFile, o.ResultFile, o.ParentImage, o.DecoderRoot })
      if (!Under(path, o.OwnedRoot)) throw new ProofFailure("invalid-scope", path);
    if (o.Mode == "PartialKill" && !Under(o.PayloadFile, o.OwnedRoot)) throw new ProofFailure("invalid-scope", o.PayloadFile);
    if (o.Mode != "PartialKill" && String.IsNullOrEmpty(o.ChildPidFile)) throw new ProofFailure("invalid-config", "Marker modes require native child marker");
    if (!String.IsNullOrEmpty(o.ChildPidFile) && !Under(o.ChildPidFile, o.OwnedRoot))
      throw new ProofFailure("invalid-scope", o.ChildPidFile);
    foreach (string path in new string[] { o.ReadyFile, o.ParentPidFile, o.ObservedFile, o.ResultFile })
      if (File.Exists(path)) throw new ProofFailure("stale-control", path);
    if (!String.IsNullOrEmpty(o.ChildPidFile) && File.Exists(o.ChildPidFile))
      throw new ProofFailure("stale-control", o.ChildPidFile);
    if (o.Mode == "MarkerExit") {
      if (!Under(o.AckFile, o.OwnedRoot) || !SamePath(o.AckFile, o.ChildPidFile + ".ack"))
        throw new ProofFailure("invalid-ack", "Expected owned child marker .ack sibling");
      if (File.Exists(o.AckFile)) throw new ProofFailure("stale-control", o.AckFile);
    } else {
      if (!Under(o.KillRequestFile, o.OwnedRoot)) throw new ProofFailure("invalid-scope", o.KillRequestFile);
      if (File.Exists(o.KillRequestFile)) throw new ProofFailure("stale-control", o.KillRequestFile);
    }
  }
  static void CleanupParent(IntPtr parent, LifeDecoderObserverResult r, List<string> failures) {
    try {
      if (Wait(parent, 0, "cleanup-parent") == Timeout) {
        if (!TerminateProcess(parent, 137)) throw Native("TerminateProcess(cleanup parent)");
        r.CleanupParentKilled = true;
        if (Wait(parent, 10000, "cleanup-parent") != Object0) throw new ProofFailure("cleanup-parent-timeout", "Parent did not exit");
      }
    } catch (Exception ex) { failures.Add("parent teardown: " + ex.ToString()); }
  }
  static void CleanupDecoder(IntPtr child, LifeDecoderObserverResult r, List<string> failures) {
    IntPtr terminate = IntPtr.Zero;
    try {
      if (Wait(child, 10000, "cleanup-decoder") == Object0) return;
      terminate = OpenProcess(QuerySyncTerminate, false, r.DecoderPid);
      if (terminate == IntPtr.Zero) throw Native("OpenProcess(cleanup decoder)");
      if (Created(terminate).ToString() != r.DecoderCreationTime || !SamePath(Image(terminate), r.DecoderImage))
        throw new ProofFailure("cleanup-identity", "Decoder identity changed");
      if (!TerminateProcess(terminate, 137)) throw Native("TerminateProcess(cleanup decoder)");
      r.CleanupDecoderKilled = true;
      if (Wait(child, 10000, "cleanup-decoder") != Object0) throw new ProofFailure("cleanup-decoder-timeout", "Decoder did not exit");
    } catch (Exception ex) { failures.Add("decoder teardown: " + ex.ToString()); }
    finally { Close(ref terminate, "decoder teardown process handle", failures); }
  }

  public static LifeDecoderObserverResult Run(LifeDecoderObserverOptions o) {
    LifeDecoderObserverResult r = new LifeDecoderObserverResult();
    r.ParentWait = r.DecoderWait = Failed;
    List<string> cleanup = new List<string>(); IntPtr parent = IntPtr.Zero, child = IntPtr.Zero;
    bool parentVerified = false, childVerified = false;
    try {
      Validate(o);
      // Force native snapshot and crypto startup before controller launches NSIS.
      Entries(); using (SHA256 warm = SHA256.Create()) { warm.ComputeHash(new byte[1]); }
      Atomic(o.ReadyFile, "ready\r\n");
      Stopwatch deadline = Stopwatch.StartNew(); string text;
      while ((text = CompleteControl(o.ParentPidFile)) == null) {
        if (deadline.ElapsedMilliseconds > 30000) throw new ProofFailure("missing-parent", "No complete parent PID record");
        Thread.SpinWait(64);
      }
      r.ParentPid = Pid(text, "parent-pid");
      parent = OpenProcess(QuerySyncTerminate, false, r.ParentPid);
      if (parent == IntPtr.Zero) throw Native("OpenProcess(NSIS)");
      Alive(parent, "parent"); r.ParentImage = Image(parent); r.ParentCreationTime = Created(parent).ToString();
      if (!SamePath(r.ParentImage, o.ParentImage)) throw new ProofFailure("parent-identity", "Unexpected NSIS executable");
      parentVerified = true; deadline.Restart();
      while (child == IntPtr.Zero) {
        Alive(parent, "parent");
        uint candidate = 0;
        if (!String.IsNullOrEmpty(o.ChildPidFile)) {
          if (o.Mode != "PartialKill") candidate = MarkerPid(o.ChildPidFile);
          else { string marker = CompleteControl(o.ChildPidFile); if (marker != null) candidate = Pid(marker, "child-pid"); }
        } else {
          foreach (Entry e in Entries()) if (e.Parent == r.ParentPid && String.Equals(e.Name, Path.GetFileName(o.DecoderSuffix), StringComparison.OrdinalIgnoreCase)) {
            if (candidate != 0) throw new ProofFailure("multiple-decoders", "More than one matching direct child");
            candidate = e.Pid;
          }
        }
        if (candidate != 0) {
          child = OpenProcess(QuerySync, false, candidate);
          if (child == IntPtr.Zero) throw new ProofFailure("decoder-open-race", Native("OpenProcess(decoder)").ToString());
          r.DecoderPid = candidate; Alive(child, "decoder"); r.DecoderImage = Image(child); r.DecoderCreationTime = Created(child).ToString();
          if (!Under(r.DecoderImage, o.DecoderRoot) || !r.DecoderImage.EndsWith("\\" + o.DecoderSuffix, StringComparison.OrdinalIgnoreCase))
            throw new ProofFailure("decoder-identity", "Unexpected decoder image location");
          r.DecoderSha256 = Hash(r.DecoderImage);
          if (!String.Equals(r.DecoderSha256, o.DecoderSha256, StringComparison.Ordinal)) throw new ProofFailure("decoder-hash", "Decoder image hash mismatch");
          if (!IsChild(r.DecoderPid, r.ParentPid)) throw new ProofFailure("decoder-parent-race", "Pinned decoder no longer has expected parent");
          Alive(parent, "parent"); Alive(child, "decoder"); childVerified = true;
        }
        if (deadline.ElapsedMilliseconds > 30000) throw new ProofFailure("missing-decoder", "No matching pinned decoder child");
        if (child == IntPtr.Zero) Thread.SpinWait(64);
      }
      Atomic(o.ObservedFile, "{\"parentPid\":" + r.ParentPid + ",\"decoderPid\":" + r.DecoderPid +
        ",\"parentCreationTime\":" + Quote(r.ParentCreationTime) + ",\"decoderCreationTime\":" + Quote(r.DecoderCreationTime) +
        ",\"decoderImage\":" + Quote(r.DecoderImage) + ",\"decoderSha256\":" + Quote(r.DecoderSha256) + "}\r\n");
      if (o.Mode == "MarkerExit") {
        Alive(child, "decoder"); Alive(parent, "parent");
        Atomic(o.AckFile, "LIFE_LAUNCHER_OBSERVER_READY_V1\n");
      } else {
        deadline.Restart();
        while ((text = CompleteControl(o.KillRequestFile)) == null) {
          Alive(parent, "parent"); Alive(child, "decoder");
          if (deadline.ElapsedMilliseconds > 30000) throw new ProofFailure("missing-kill-request", "No actual partial-content kill request");
          Thread.SpinWait(64);
        }
        if (!String.Equals(text, o.RequestToken + "\r\n", StringComparison.Ordinal)) throw new ProofFailure("invalid-kill-request", "Wrong request token");
        if (o.Mode == "PartialKill") Partial(o, r, false);
        Alive(child, "decoder"); Alive(parent, "parent");
        if (!TerminateProcess(parent, 137)) throw Native("TerminateProcess(NSIS)");
        r.ParentKilled = true;
      }
      r.ParentWait = Wait(parent, 10000, "parent");
      if (r.ParentWait != Object0) throw new ProofFailure("parent-wait-timeout", "NSIS did not exit within native observer wait");
      r.DecoderWait = Wait(child, 10000, "decoder");
      if (r.DecoderWait != Object0) throw new ProofFailure("decoder-wait-timeout", "Decoder survived installer/job owner termination");
      if (!GetExitCodeProcess(parent, out r.ParentExit)) throw Native("GetExitCodeProcess(parent)");
      if (!GetExitCodeProcess(child, out r.DecoderExit)) throw Native("GetExitCodeProcess(decoder)");
      if (o.Mode == "MarkerExit" && r.ParentExit != 77)
        throw new ProofFailure("parent-exit-code", "Expected exact terminal accounting-failure exit 77, got " + r.ParentExit);
      if (o.Mode == "PartialKill") Partial(o, r, true);
      r.Success = true;
    } catch (Exception ex) {
      ProofFailure proof = ex as ProofFailure;
      r.FailureKind = proof == null ? "native-or-io-failure" : proof.Kind; r.Failure = ex.ToString();
      // Teardown is separate evidence and can never turn an inconclusive/raced
      // attempt into a passed lifetime proof. Never kill an unverified parent.
      if (parentVerified) CleanupParent(parent, r, cleanup);
      if (childVerified) CleanupDecoder(child, r, cleanup);
    } finally {
      Close(ref child, "pinned decoder process handle", cleanup);
      Close(ref parent, "pinned NSIS process handle", cleanup);
      r.CleanupFailures = cleanup.ToArray();
      if (cleanup.Count != 0) { r.Success = false; if (r.FailureKind == null) { r.FailureKind = "cleanup-failure"; r.Failure = String.Join("\n", cleanup.ToArray()); } }
    }
    return r;
  }
}
`

const decoderObserverScript =
  [
    'param([Parameter(Mandatory)][string]$ConfigPath)',
    "$ErrorActionPreference = 'Stop'",
    'Set-StrictMode -Version Latest',
    '$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json',
    "Add-Type -Path (Join-Path $PSScriptRoot 'life-modern-decoder-observer.cs')",
    '$options = [LifeDecoderObserverOptions]::new()',
    "foreach ($name in @('OwnedRoot','ReadyFile','ParentPidFile','ObservedFile','ResultFile','ParentImage','DecoderRoot','DecoderSuffix','DecoderSha256','Mode')) {",
    '  $options.$name = [string]$config.$name',
    '}',
    "if ($config.PSObject.Properties.Name -contains 'ChildPidFile') { $options.ChildPidFile = [string]$config.ChildPidFile }",
    "if ($options.Mode -ceq 'MarkerExit') { $options.AckFile = [string]$config.AckFile }",
    'else {',
    '  $options.KillRequestFile = [string]$config.KillRequestFile',
    '  $options.RequestToken = [string]$config.RequestToken',
    '}',
    "if ($options.Mode -ceq 'PartialKill') {",
    '  $options.PayloadFile = [string]$config.PayloadFile',
    '  $options.ExpectedSize = [Int64]$config.ExpectedSize',
    '  $options.Prefix = [Convert]::FromBase64String([string]$config.PrefixBase64)',
    '  $options.Tail = [Convert]::FromBase64String([string]$config.TailBase64)',
    '}',
    '$result = [LifeDecoderObserver]::Run($options)',
    '$json = ConvertTo-Json -InputObject $result -Depth 8 -Compress',
    '[LifeDecoderObserver]::PublishResult($options, $json)',
    'if (-not $result.Success) { exit 7 }',
  ].join('\n') + '\n'

const fakeDecoderNative = String.raw`using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

// Scratch-only executable and shared observer source. Never ship this fixture.
public static class LifeFixtureNative
{
    [StructLayout(LayoutKind.Sequential)] public struct FileTime { public uint Low, High; }
    [StructLayout(LayoutKind.Sequential)] public struct FileInfo {
        public uint Attributes; public FileTime Created, Accessed, Written;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern uint GetFullPathNameW(string path, uint size, StringBuilder buffer, IntPtr part);
    [DllImport("kernel32.dll", SetLastError=true)]
    internal static extern SafeWaitHandle OpenProcess(uint rights, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError=true)]
    internal static extern bool GetProcessTimes(SafeWaitHandle process, out FileTime created, out FileTime exited, out FileTime kernel, out FileTime user);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    internal static extern bool QueryFullProcessImageNameW(SafeWaitHandle process, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll", SetLastError=true)]
    internal static extern uint WaitForSingleObject(SafeWaitHandle handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)]
    internal static extern bool GetExitCodeProcess(SafeWaitHandle process, out uint code);
    [DllImport("kernel32.dll", SetLastError=true)]
    internal static extern bool TerminateProcess(SafeWaitHandle process, uint code);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInfo info);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern uint GetFileAttributesW(string path);

    public static string Normalize(string path) {
        if (String.IsNullOrEmpty(path) || path.Length < 3 || !Char.IsLetter(path[0]) || path[1] != ':' || path[2] != '\\') throw new InvalidOperationException("Drive-absolute path required.");
        for (int i=0; i<path.Length; i++) if (path[i] < 32 || path[i] == '*' || path[i] == '?' || path[i] == '"' || (path[i] == ':' && i != 1)) throw new InvalidOperationException("Unsafe fixture path.");
        StringBuilder buffer=new StringBuilder(32768);
        uint count=GetFullPathNameW(path, (uint)buffer.Capacity, buffer, IntPtr.Zero);
        int error=Marshal.GetLastWin32Error();
        if (count == 0) throw new Win32Exception(error, "GetFullPathNameW");
        if (count >= buffer.Capacity || count != buffer.Length) throw new InvalidOperationException("Unexpected normalized path length.");
        return buffer.ToString().TrimEnd('\\');
    }
    public static string Owned(string root, string path) {
        root=Normalize(root); path=Normalize(path);
        if (root.Length <= 3 || !path.StartsWith(root+"\\", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Fixture path escaped owned root.");
        return path;
    }
    public static void OrdinaryDirectory(string root, string path) {
        root=Normalize(root); path=Normalize(path);
        if (!String.Equals(root,path,StringComparison.OrdinalIgnoreCase)) path=Owned(root,path);
        for (;;) {
            uint attrs=GetFileAttributesW(path); int error=Marshal.GetLastWin32Error();
            if (attrs == UInt32.MaxValue) throw new Win32Exception(error,"GetFileAttributesW(directory)");
            if ((attrs & 0x410) != 0x10) throw new InvalidOperationException("Fixture directory must be ordinary.");
            if (String.Equals(root,path,StringComparison.OrdinalIgnoreCase)) break;
            int slash=path.LastIndexOf('\\');
            if (slash <= 2) throw new InvalidOperationException("Unexpected directory ancestry.");
            path=path.Substring(0,slash);
        }
    }
    public static string FileIdentity(string path) {
        using (SafeFileHandle file=CreateFileW(path,0x80,7,IntPtr.Zero,3,0x00200000,IntPtr.Zero)) {
            int error=Marshal.GetLastWin32Error();
            if (file.IsInvalid) throw new Win32Exception(error,"CreateFileW(identity)");
            FileInfo info;
            if (!GetFileInformationByHandle(file,out info)) throw new Win32Exception(Marshal.GetLastWin32Error(),"GetFileInformationByHandle");
            if ((info.Attributes & 0x410) != 0) throw new InvalidOperationException("Fixture identity must be ordinary file.");
            return info.Volume.ToString("x8")+":"+info.IndexHigh.ToString("x8")+info.IndexLow.ToString("x8");
        }
    }
    public static long Creation(SafeWaitHandle process) {
        FileTime created,exited,kernel,user;
        if (!GetProcessTimes(process,out created,out exited,out kernel,out user)) throw new Win32Exception(Marshal.GetLastWin32Error(),"GetProcessTimes");
        return unchecked((long)(((ulong)created.High << 32) | created.Low));
    }
    public static string Image(SafeWaitHandle process) {
        StringBuilder image=new StringBuilder(32768); uint count=(uint)image.Capacity;
        if (!QueryFullProcessImageNameW(process,0,image,ref count)) throw new Win32Exception(Marshal.GetLastWin32Error(),"QueryFullProcessImageNameW");
        if (count == 0 || count >= image.Capacity || count != image.Length) throw new InvalidOperationException("Unexpected image length.");
        return image.ToString();
    }
    public static string Quote(string value) {
        StringBuilder result=new StringBuilder("\""); int slashes=0;
        foreach(char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { result.Append('\\',slashes*2+1); result.Append(c); }
            else { result.Append('\\',slashes); result.Append(c); }
            slashes=0;
        }
        result.Append('\\',slashes*2); result.Append('"'); return result.ToString();
    }
    public static string Witness(uint pid, long created, string image) {
        return "pid="+pid.ToString(CultureInfo.InvariantCulture)+"\ncreation="+created.ToString(CultureInfo.InvariantCulture)+"\nimage="+image+"\n";
    }
    public static void AtomicWitness(string filename,string text) {
        string temporary=filename+".tmp";
        using (FileStream stream=new FileStream(temporary,FileMode.CreateNew,FileAccess.Write,FileShare.Read)) {
            byte[] bytes=new UTF8Encoding(false,true).GetBytes(text); stream.Write(bytes,0,bytes.Length); stream.Flush(true);
        }
        File.Move(temporary,filename);
    }
}

// Keep this instance alive across acknowledgment, raw Launch completion and
// the nonblocking exit check. Decimal creation strings avoid JS 53-bit loss.
public sealed class LifeFixturePinnedProcess : IDisposable
{
    private SafeWaitHandle handle;
    public readonly uint Pid;
    public readonly string Creation;
    public readonly string Image;
    public readonly string ImageIdentity;
    public LifeFixturePinnedProcess(uint pid,string expectedCreation,string expectedImage) {
        handle=LifeFixtureNative.OpenProcess(0x00101001,false,pid);
        int error=Marshal.GetLastWin32Error();
        if (handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(error,"OpenProcess(pin)"); }
        try {
            Pid=pid; Creation=LifeFixtureNative.Creation(handle).ToString(CultureInfo.InvariantCulture);
            Image=LifeFixtureNative.Image(handle); ImageIdentity=LifeFixtureNative.FileIdentity(Image);
            if (Creation != expectedCreation || ImageIdentity != LifeFixtureNative.FileIdentity(expectedImage)) throw new InvalidOperationException("Pinned process identity mismatch.");
        } catch { handle.Dispose(); throw; }
    }
    public bool IsAlive() {
        uint state=LifeFixtureNative.WaitForSingleObject(handle,0);
        if (state == 258) return true;
        if (state == 0) return false;
        if (state == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error(),"WaitForSingleObject(pin)");
        throw new InvalidOperationException("Unexpected process wait state.");
    }
    public uint RequireExitedNow() {
        if (IsAlive()) throw new InvalidOperationException("Pinned process remains alive at return boundary.");
        uint code;
        if (!LifeFixtureNative.GetExitCodeProcess(handle,out code)) throw new Win32Exception(Marshal.GetLastWin32Error(),"GetExitCodeProcess");
        if (code == 259) throw new InvalidOperationException("Fixture process reported STILL_ACTIVE.");
        return code;
    }
    public void TerminateForCleanup() {
        if (IsAlive() && !LifeFixtureNative.TerminateProcess(handle,97)) throw new Win32Exception(Marshal.GetLastWin32Error(),"TerminateProcess(cleanup)");
        uint state=LifeFixtureNative.WaitForSingleObject(handle,10000);
        if (state != 0) throw new InvalidOperationException("Pinned cleanup process did not terminate.");
    }
    public void Dispose() { if (handle != null) { handle.Dispose(); handle=null; } }
}

public static class LifeFakeDecoder
{
    private static readonly string[] FixedArgs={"x","-t7z","-y","-aoa","-bd","-bb0","-bso0","-bse0","-bsp0"};
    public static int Main(string[] args) {
        try {
            if (args.Length == 4 && args[0] == "--child") return Child(args[1],args[2],args[3]);
            if (args.Length != 12) throw new InvalidOperationException("Expected exactly twelve decoder arguments.");
            for(int i=0;i<FixedArgs.Length;i++) if(args[i] != FixedArgs[i]) throw new InvalidOperationException("Unexpected decoder switch "+i);
            if (!args[9].StartsWith("-o",StringComparison.Ordinal) || args[10] != "--") throw new InvalidOperationException("Unexpected output/archive arguments.");
            Dictionary<string,string> config=new Dictionary<string,string>(StringComparer.Ordinal);
            foreach(string line in File.ReadAllLines(args[11],new UTF8Encoding(false,true))) {
                if (line.Length == 0) continue; int equals=line.IndexOf('=');
                if (equals <= 0) throw new InvalidOperationException("Malformed fixture config.");
                config.Add(line.Substring(0,equals),line.Substring(equals+1));
            }
            if (config.Count != 4 || (config["mode"] != "spawn-descendant-nonzero" && config["mode"] != "spawn-descendant-zero")) throw new InvalidOperationException("Unexpected fixture config.");
            string root=LifeFixtureNative.Normalize(config["root"]);
            string archive=LifeFixtureNative.Owned(root,args[11]);
            string output=LifeFixtureNative.Owned(root,args[9].Substring(2));
            string witness=LifeFixtureNative.Owned(root,config["witness"]);
            LifeFixtureNative.OrdinaryDirectory(root,root);
            LifeFixtureNative.OrdinaryDirectory(root,output);
            LifeFixtureNative.OrdinaryDirectory(root,witness.Substring(0,witness.LastIndexOf('\\')));
            LifeFixtureNative.FileIdentity(archive);
            // Use the owned caller's spelling for launch paths. Native image
            // queries may expand an 8.3 ancestor; compare physical identity.
            string self=LifeFixtureNative.Owned(root,config["exe"]);
            LifeFixtureNative.OrdinaryDirectory(root,self.Substring(0,self.LastIndexOf('\\')));
            LifeFixtureNative.OrdinaryDirectory(root,archive.Substring(0,archive.LastIndexOf('\\')));
            uint pid=unchecked((uint)Process.GetCurrentProcess().Id);
            using (SafeWaitHandle current=LifeFixtureNative.OpenProcess(0x00101000,false,pid)) {
                if(current.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(),"OpenProcess(self)");
                string image=LifeFixtureNative.Image(current);
                if(LifeFixtureNative.FileIdentity(image) != LifeFixtureNative.FileIdentity(self)) throw new InvalidOperationException("Owned executable identity mismatch.");
                LifeFixtureNative.AtomicWitness(witness+".parent-started",LifeFixtureNative.Witness(pid,LifeFixtureNative.Creation(current),image));
            }
            ProcessStartInfo start=new ProcessStartInfo(self,"--child "+LifeFixtureNative.Quote(root)+" "+LifeFixtureNative.Quote(witness)+" "+LifeFixtureNative.Quote(output));
            start.UseShellExecute=false; start.CreateNoWindow=true;
            using(Process child=Process.Start(start)) {
                if(child == null) throw new InvalidOperationException("Child process did not start.");
                Stopwatch deadline=Stopwatch.StartNew(); string childStarted=witness+".child-started";
                while(!File.Exists(childStarted)) {
                    if(child.HasExited || deadline.ElapsedMilliseconds > 30000) throw new InvalidOperationException("Child startup handshake failed.");
                    Thread.Sleep(5);
                }
                string identity=File.ReadAllText(childStarted,new UTF8Encoding(false,true));
                LifeFixtureNative.AtomicWitness(witness+".parent-ready",identity);
                string ack=witness+".ack";
                while(!File.Exists(ack)) {
                    if(child.HasExited || deadline.ElapsedMilliseconds > 30000) throw new InvalidOperationException("Node acknowledgment handshake failed.");
                    Thread.Sleep(5);
                }
                if(File.ReadAllText(ack,new UTF8Encoding(false,true)) != identity || child.HasExited) throw new InvalidOperationException("Acknowledgment identity mismatch or child died early.");
                return config["mode"] == "spawn-descendant-zero" ? 0 : 9;
            }
        } catch(Exception error) { Console.Error.WriteLine(error.ToString()); return 91; }
    }
    private static int Child(string rawRoot,string rawWitness,string rawOutput) {
        string root=LifeFixtureNative.Normalize(rawRoot);
        string witness=LifeFixtureNative.Owned(root,rawWitness);
        string output=LifeFixtureNative.Owned(root,rawOutput);
        LifeFixtureNative.OrdinaryDirectory(root,root);
        LifeFixtureNative.OrdinaryDirectory(root,output);
        LifeFixtureNative.OrdinaryDirectory(root,witness.Substring(0,witness.LastIndexOf('\\')));
        uint pid=unchecked((uint)Process.GetCurrentProcess().Id);
        using(SafeWaitHandle current=LifeFixtureNative.OpenProcess(0x00101000,false,pid)) {
            if(current.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(),"OpenProcess(child-self)");
            string identity=LifeFixtureNative.Witness(pid,LifeFixtureNative.Creation(current),LifeFixtureNative.Image(current));
            string sentinel=LifeFixtureNative.Owned(root,output+"\\descendant-writes.bin");
            byte[] bytes=Encoding.ASCII.GetBytes("LIFE_FIXTURE_CHILD\n");
            using(FileStream stream=new FileStream(sentinel,FileMode.CreateNew,FileAccess.Write,FileShare.ReadWrite)) {
                stream.Write(bytes,0,bytes.Length); stream.Flush(true);
                LifeFixtureNative.AtomicWitness(witness+".pid",pid.ToString(CultureInfo.InvariantCulture));
                LifeFixtureNative.AtomicWitness(witness+".child-started",identity);
                Stopwatch safety=Stopwatch.StartNew();
                while(safety.ElapsedMilliseconds < 90000) { stream.Write(bytes,0,bytes.Length); stream.Flush(true); Thread.Sleep(10); }
            }
        }
        return 93;
    }
}
`

const fakeDecoderCompileScript =
  [
    'param([Parameter(Mandatory=$true)][string]$OwnedRoot,[Parameter(Mandatory=$true)][string]$Source,[Parameter(Mandatory=$true)][string]$Output)',
    "$ErrorActionPreference = 'Stop'",
    'Set-StrictMode -Version Latest',
    "if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSEdition -ne 'Desktop') { throw 'Fixture executable compilation requires Windows PowerShell 5 Desktop.' }",
    "$rootPath = [IO.Path]::GetFullPath($OwnedRoot).TrimEnd([char]'\\')",
    '$sourcePath = [IO.Path]::GetFullPath($Source)',
    '$outputPath = [IO.Path]::GetFullPath($Output)',
    "if ($rootPath.Length -le 3 -or -not $sourcePath.StartsWith($rootPath + '\\',[StringComparison]::OrdinalIgnoreCase) -or -not $outputPath.StartsWith($rootPath + '\\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Compiler source and executable must stay inside owned scratch.' }",
    "if (-not $outputPath.EndsWith('.exe',[StringComparison]::OrdinalIgnoreCase) -or [IO.File]::Exists($outputPath)) { throw 'Compiler output must be a fresh owned executable.' }",
    "Add-Type -Path $sourcePath -OutputAssembly $outputPath -OutputType ConsoleApplication -ReferencedAssemblies 'System.dll','System.Core.dll'",
    "if (-not [IO.File]::Exists($outputPath)) { throw 'Fixture compiler did not create the executable.' }",
    '[PSCustomObject]@{ Source = $sourcePath; Output = $outputPath } | ConvertTo-Json -Compress',
  ].join('\n') + '\n'

const fakeDecoderObserverScript =
  [
    "$ErrorActionPreference = 'Stop'",
    'Set-StrictMode -Version Latest',
    "if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSEdition -ne 'Desktop') { throw 'Observer requires Windows PowerShell 5 Desktop.' }",
    '# All values are literal environment data passed to this child, never command text.',
    "$rootInput = [Environment]::GetEnvironmentVariable('LIFE_FIXTURE_OBSERVER_ROOT')",
    "$sourceInput = [Environment]::GetEnvironmentVariable('LIFE_FIXTURE_OBSERVER_SOURCE')",
    "$witnessInput = [Environment]::GetEnvironmentVariable('LIFE_FIXTURE_OBSERVER_WITNESS')",
    "$exeInput = [Environment]::GetEnvironmentVariable('LIFE_FIXTURE_OBSERVER_EXE')",
    "$outputInput = [Environment]::GetEnvironmentVariable('LIFE_FIXTURE_OBSERVER_OUTPUT')",
    "$expectedRootExit = [Environment]::GetEnvironmentVariable('LIFE_FIXTURE_OBSERVER_ROOT_EXIT')",
    "if ($expectedRootExit -cne '0' -and $expectedRootExit -cne '9') { throw 'Observer requires exact expected root exit 0 or 9.' }",
    "foreach ($value in @($rootInput,$sourceInput,$witnessInput,$exeInput,$outputInput)) { if ([String]::IsNullOrEmpty($value)) { throw 'Missing literal observer environment.' } }",
    "$preRoot = [IO.Path]::GetFullPath($rootInput).TrimEnd([char]'\\')",
    '$preSource = [IO.Path]::GetFullPath($sourceInput)',
    "if ($preRoot.Length -le 3 -or -not $preSource.StartsWith($preRoot + '\\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Observer C# source escaped owned scratch.' }",
    'Add-Type -Path $preSource',
    '$root = [LifeFixtureNative]::Normalize($rootInput)',
    '$source = [LifeFixtureNative]::Owned($root,$sourceInput)',
    '$witness = [LifeFixtureNative]::Owned($root,$witnessInput)',
    '$exe = [LifeFixtureNative]::Owned($root,$exeInput)',
    '$output = [LifeFixtureNative]::Owned($root,$outputInput)',
    '[LifeFixtureNative]::OrdinaryDirectory($root,$root)',
    '[LifeFixtureNative]::OrdinaryDirectory($root,$output)',
    "[LifeFixtureNative]::OrdinaryDirectory($root,$witness.Substring(0,$witness.LastIndexOf('\\')))",
    "[LifeFixtureNative]::OrdinaryDirectory($root,$exe.Substring(0,$exe.LastIndexOf('\\')))",
    '[LifeFixtureNative]::FileIdentity($source) | Out-Null',
    '[LifeFixtureNative]::FileIdentity($exe) | Out-Null',
    '$utf8 = [Text.UTF8Encoding]::new($false,$true)',
    '$pinned = $null',
    '$rootPinned = $null',
    '$primary = $null',
    '$cleanup = $null',
    'function Get-SentinelSnapshot([String]$filename) {',
    '  $bytes = [IO.File]::ReadAllBytes($filename)',
    '  $digest = [Security.Cryptography.SHA256]::Create()',
    "  try { $hash = [BitConverter]::ToString($digest.ComputeHash($bytes)).Replace('-','').ToLowerInvariant() } finally { $digest.Dispose() }",
    '  [PSCustomObject]@{ Bytes = $bytes.Length; Sha256 = $hash }',
    '}',
    'function Get-FixtureIdentity([String]$filename) {',
    '  $identityText = [IO.File]::ReadAllText($filename,$utf8)',
    '  $identity = @{}',
    '  foreach ($line in $identityText.Split([char]"`n")) {',
    '    if ($line.Length -eq 0) { continue }',
    "    $equals = $line.IndexOf('=')",
    "    if ($equals -le 0) { throw 'Malformed child identity witness.' }",
    '    $key = $line.Substring(0,$equals)',
    "    if ($identity.ContainsKey($key)) { throw 'Repeated child identity key.' }",
    '    $identity.Add($key,$line.Substring($equals + 1))',
    '  }',
    "  if ($identity.Count -ne 3 -or -not $identity.ContainsKey('pid') -or -not $identity.ContainsKey('creation') -or -not $identity.ContainsKey('image')) { throw 'Incomplete child identity witness.' }",
    "  if ($identity.pid -cnotmatch '^[1-9][0-9]*$' -or $identity.creation -cnotmatch '^[1-9][0-9]*$') { throw 'PID and creation must be positive exact decimal strings.' }",
    '  return $identity',
    '}',
    'try {',
    '  $clock = [Diagnostics.Stopwatch]::StartNew()',
    "  $started = $witness + '.child-started'",
    '  while (-not [IO.File]::Exists($started)) {',
    "    if ($clock.ElapsedMilliseconds -gt 30000) { throw 'Timed out waiting for child identity witness.' }",
    '    [Threading.Thread]::Sleep(5)',
    '  }',
    '  $identityText = [IO.File]::ReadAllText($started,$utf8)',
    '  $identity = Get-FixtureIdentity $started',
    "  $rootIdentity = Get-FixtureIdentity ($witness + '.parent-started')",
    '  $rootPinned = [LifeFixturePinnedProcess]::new([UInt32]::Parse($rootIdentity.pid,[Globalization.CultureInfo]::InvariantCulture),[String]$rootIdentity.creation,[String]$exe)',
    "  if ($rootPinned.Image -cne $rootIdentity.image -or -not $rootPinned.IsAlive()) { throw 'Pinned decoder root identity changed or root exited before acknowledgment.' }",
    "  if ([IO.File]::ReadAllText($witness + '.pid',$utf8) -cne $identity.pid) { throw 'Plain native PID marker does not match pinned witness.' }",
    '  $pinned = [LifeFixturePinnedProcess]::new([UInt32]::Parse($identity.pid,[Globalization.CultureInfo]::InvariantCulture),[String]$identity.creation,[String]$exe)',
    "  if ($pinned.Image -cne $identity.image -or -not $pinned.IsAlive()) { throw 'Pinned child identity changed or child is already terminated.' }",
    "  $sentinel = [LifeFixtureNative]::Owned($root,$output + '\\descendant-writes.bin')",
    '  $firstLength = ([IO.FileInfo]::new($sentinel)).Length',
    "  if ($firstLength -le 0) { throw 'Child did not flush first sentinel record.' }",
    '  $progress = [Diagnostics.Stopwatch]::StartNew()',
    '  while (([IO.FileInfo]::new($sentinel)).Length -le $firstLength) {',
    "    if (-not $pinned.IsAlive() -or $progress.ElapsedMilliseconds -gt 5000) { throw 'Pinned live child did not continue writing before acknowledgment.' }",
    '    [Threading.Thread]::Sleep(5)',
    '  }',
    '  $ready = [PSCustomObject]@{ Pid = $pinned.Pid; Creation = $pinned.Creation; Image = $pinned.Image; ImageIdentity = $pinned.ImageIdentity; FirstBytes = $firstLength; ProgressBytes = ([IO.FileInfo]::new($sentinel)).Length; RootPid = $rootPinned.Pid; RootCreation = $rootPinned.Creation; RootImage = $rootPinned.Image }',
    "  [LifeFixtureNative]::AtomicWitness($witness + '.observer-ready.json',(ConvertTo-Json -InputObject $ready -Depth 4 -Compress))",
    "  if (-not $pinned.IsAlive() -or -not $rootPinned.IsAlive()) { throw 'Child or decoder root died before acknowledgment.' }",
    "  [LifeFixtureNative]::AtomicWitness($witness + '.ack',$identityText)",
    "  # The fixture's immediate native post-Launch check must precede Node creating",
    '  # this marker. This observer checks again without a blocking exit wait.',
    "  $completion = $witness + '.launch-complete'",
    '  while (-not [IO.File]::Exists($completion)) {',
    "    if ($clock.ElapsedMilliseconds -gt 60000) { throw 'Timed out waiting for raw Launch completion.' }",
    '    [Threading.Thread]::Sleep(5)',
    '  }',
    '  if ([IO.File]::ReadAllText($completion,$utf8) -cne "error`n") { throw \'Launch completion marker must report exact error.\' }',
    '  $exitCode = $pinned.RequireExitedNow()',
    '  $rootExitCode = $rootPinned.RequireExitedNow()',
    "  if ($rootExitCode -ne [UInt32]::Parse($expectedRootExit,[Globalization.CultureInfo]::InvariantCulture)) { throw 'Decoder root did not exit with its exact configured code.' }",
    "  if ($exitCode -eq 91 -or $exitCode -eq 93) { throw 'Child fixture failed or reached its watchdog instead of launcher cleanup.' }",
    '  $before = Get-SentinelSnapshot $sentinel',
    '  [Threading.Thread]::Sleep(25)',
    '  $after = Get-SentinelSnapshot $sentinel',
    "  if ($before.Bytes -ne $after.Bytes -or $before.Sha256 -cne $after.Sha256 -or $pinned.IsAlive()) { throw 'Terminated child output changed after completed wait.' }",
    '  $finished = [PSCustomObject]@{ Pid = $pinned.Pid; Creation = $pinned.Creation; Image = $pinned.Image; ExitCode = $exitCode; Bytes = $after.Bytes; Sha256 = $after.Sha256; RootPid = $rootPinned.Pid; RootCreation = $rootPinned.Creation; RootImage = $rootPinned.Image; RootExitCode = $rootExitCode }',
    "  [LifeFixtureNative]::AtomicWitness($witness + '.observer-finished.json',(ConvertTo-Json -InputObject $finished -Depth 4 -Compress))",
    '  [Console]::WriteLine((ConvertTo-Json -InputObject $finished -Depth 4 -Compress))',
    '} catch { $primary = $_.Exception; [Console]::Error.WriteLine($primary.ToString()) }',
    'finally {',
    '  foreach ($ownedProcess in @($rootPinned,$pinned)) {',
    '    if ($null -eq $ownedProcess) { continue }',
    "    if ($null -ne $primary) { try { $ownedProcess.TerminateForCleanup() } catch { if ($null -eq $cleanup) { $cleanup = $_.Exception } else { $cleanup = [AggregateException]::new('Observer cleanup failures',[Exception[]]@($cleanup,$_.Exception)) }; [Console]::Error.WriteLine('Observer cleanup failure: ' + $_.Exception.ToString()) } }",
    '    $ownedProcess.Dispose()',
    '  }',
    '}',
    'if ($null -ne $primary -or $null -ne $cleanup) { exit 1 }',
  ].join('\n') + '\n'

const directoryMutationNative = String.raw`using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

// Scratch-only diagnostic: report actual results, including successful mutation.
public static class LifeFixtureDirectoryMutation
{
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    private static extern uint GetFullPathNameW(string path,uint size,StringBuilder result,IntPtr part);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    private static extern uint GetFileAttributesW(string path);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    private static extern IntPtr CreateFileW(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)]
    [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool DeviceIoControl(IntPtr handle,uint control,[In]byte[] input,uint inputSize,IntPtr output,uint outputSize,out uint returned,IntPtr overlapped);
    [DllImport("kernel32.dll",SetLastError=true)]
    [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
    [StructLayout(LayoutKind.Sequential)] private struct FileTime { public uint Low,High; }
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] private struct FindData {
        public uint Attributes; public FileTime Created,Accessed,Written;
        public uint SizeHigh,SizeLow,Reserved0,Reserved1;
        [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string Name;
        [MarshalAs(UnmanagedType.ByValTStr,SizeConst=14)] public string Alternate;
    }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    private static extern IntPtr FindFirstFileW(string pattern,out FindData data);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool FindNextFileW(IntPtr find,out FindData data);
    [DllImport("kernel32.dll",SetLastError=true)]
    [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool FindClose(IntPtr find);

    public sealed class Result {
        public string root,target,outside,sentinel,lease;
        public string[] targetEntries;
        public bool writeOpen,attrOpen;
        public string writeHandle,attrHandle;
        public int writeError,attrError,writeLastErrorCaptured,attrLastErrorCaptured;
        public bool? setReparse;
        public int? setReparseError,setReparseLastErrorCaptured;
        public uint? bytesReturned;
        public bool? writeClosed,attrClosed;
        public int? writeCloseError,attrCloseError;
        public int inputBytes;
        public uint targetAttributesAfter;
        public int targetAttributesError;
    }
    public static string Normalize(string path) {
        if(String.IsNullOrEmpty(path) || path.Length < 3 || !((path[0]>='A'&&path[0]<='Z')||(path[0]>='a'&&path[0]<='z')) || path[1]!=':' || path[2]!='\\') throw new InvalidOperationException("Expected drive-absolute fixture path.");
        for(int i=0;i<path.Length;i++) if(path[i]<32 || path[i]=='*' || path[i]=='?' || path[i]=='"' || (path[i]==':'&&i!=1)) throw new InvalidOperationException("Unsafe fixture path.");
        StringBuilder buffer=new StringBuilder(32768);
        uint count=GetFullPathNameW(path,(uint)buffer.Capacity,buffer,IntPtr.Zero); int error=Marshal.GetLastWin32Error();
        if(count==0) throw new Win32Exception(error,"GetFullPathNameW");
        if(count>=buffer.Capacity || count!=buffer.Length) throw new InvalidOperationException("Normalized path overflow.");
        return buffer.ToString().TrimEnd('\\');
    }
    private static string Owned(string root,string path) {
        path=Normalize(path);
        if(root.Length<=3 || !path.StartsWith(root+"\\",StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Mutation path escaped exact owned root.");
        return path;
    }
    private static uint Attributes(string path) {
        uint attributes=GetFileAttributesW(path); int error=Marshal.GetLastWin32Error();
        if(attributes==UInt32.MaxValue) throw new Win32Exception(error,"GetFileAttributesW(precondition)");
        return attributes;
    }
    private static void OrdinaryDirectory(string root,string path) {
        if(!String.Equals(path,root,StringComparison.OrdinalIgnoreCase)) path=Owned(root,path);
        for(;;) {
            if((Attributes(path)&0x410)!=0x10) throw new InvalidOperationException("Expected ordinary directory before mutation.");
            if(String.Equals(path,root,StringComparison.OrdinalIgnoreCase)) return;
            int slash=path.LastIndexOf('\\');
            if(slash<=2) throw new InvalidOperationException("Directory containment failed.");
            path=path.Substring(0,slash);
        }
    }
    private static void U16(byte[] buffer,int offset,int value) {
        if(value<0 || value>UInt16.MaxValue) throw new InvalidOperationException("Reparse USHORT overflow.");
        buffer[offset]=(byte)value; buffer[offset+1]=(byte)(value>>8);
    }
    public static byte[] MountPointBuffer(string outside) {
        // Offsets are bytes relative to PathBuffer; lengths exclude UTF-16 NUL.
        byte[] substitute=Encoding.Unicode.GetBytes("\\??\\"+outside);
        byte[] print=Encoding.Unicode.GetBytes(outside);
        int printOffset=checked(substitute.Length+2);
        int dataBytes=checked(8+substitute.Length+2+print.Length+2);
        int total=checked(8+dataBytes);
        if(total>16384 || (substitute.Length&1)!=0 || (print.Length&1)!=0) throw new InvalidOperationException("Reparse buffer exceeds native bounds.");
        byte[] buffer=new byte[total];
        buffer[0]=3; buffer[1]=0; buffer[2]=0; buffer[3]=0xA0; // IO_REPARSE_TAG_MOUNT_POINT.
        U16(buffer,4,dataBytes); U16(buffer,6,0);
        U16(buffer,8,0); U16(buffer,10,substitute.Length);
        U16(buffer,12,printOffset); U16(buffer,14,print.Length);
        Buffer.BlockCopy(substitute,0,buffer,16,substitute.Length);
        Buffer.BlockCopy(print,0,buffer,16+printOffset,print.Length);
        return buffer;
    }
    private static bool Valid(IntPtr handle) { return handle!=new IntPtr(-1)&&handle!=IntPtr.Zero; }
    private static string[] ExactEntries(string target,string lease) {
        List<string> entries=new List<string>(); FindData data;
        IntPtr find=FindFirstFileW(target+"\\*",out data); int error=Marshal.GetLastWin32Error();
        if(!Valid(find)) { if(error==2) { if(lease!=null) throw new InvalidOperationException("Expected exact lease is absent."); return entries.ToArray(); } throw new Win32Exception(error,"FindFirstFileW(target)"); }
        Exception primary=null;
        try {
            for(;;) {
                if(data.Name!="."&&data.Name!="..") {
                    if(String.IsNullOrEmpty(data.Name)||data.Name.IndexOf('\\')>=0||data.Name.IndexOf('/')>=0) throw new InvalidOperationException("Unexpected native directory entry name.");
                    string full=target+"\\"+data.Name; entries.Add(full);
                    if(lease==null || !String.Equals(full,lease,StringComparison.Ordinal) || (data.Attributes&0x410)!=0) throw new InvalidOperationException("Only the exact ordinary lease may occupy the paused target.");
                }
                bool more=FindNextFileW(find,out data); error=Marshal.GetLastWin32Error();
                if(!more) { if(error!=18) throw new Win32Exception(error,"FindNextFileW(target)"); break; }
            }
            if(lease!=null && entries.Count!=1) throw new InvalidOperationException("Paused target must contain exactly one known lease.");
        } catch(Exception failure) { primary=failure; }
        finally {
            bool closed=FindClose(find); int closeError=Marshal.GetLastWin32Error();
            if(!closed) { Exception cleanup=new Win32Exception(closeError,"FindClose(target)"); if(primary!=null) primary=new AggregateException(primary,cleanup); else primary=cleanup; }
        }
        if(primary!=null) throw primary;
        return entries.ToArray();
    }
    public static Result Probe(string rawRoot,string rawTarget,string rawOutside,string rawSentinel,string rawLease=null) {
        string root=Normalize(rawRoot),target=Owned(root,rawTarget),outside=Owned(root,rawOutside),sentinel=Owned(root,rawSentinel);
        if(String.Equals(target,outside,StringComparison.OrdinalIgnoreCase) || target.StartsWith(outside+"\\",StringComparison.OrdinalIgnoreCase) || outside.StartsWith(target+"\\",StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Target and outside directories must be disjoint.");
        if(!sentinel.StartsWith(outside+"\\",StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Outside sentinel escaped outside target.");
        OrdinaryDirectory(root,root); OrdinaryDirectory(root,target); OrdinaryDirectory(root,outside);
        OrdinaryDirectory(root,sentinel.Substring(0,sentinel.LastIndexOf('\\')));
        if((Attributes(sentinel)&0x410)!=0) throw new InvalidOperationException("Outside sentinel must be an existing ordinary file.");
        string lease=String.IsNullOrEmpty(rawLease)?null:Owned(root,rawLease);
        if(lease!=null && !String.Equals(lease.Substring(0,lease.LastIndexOf('\\')),target,StringComparison.Ordinal)) throw new InvalidOperationException("Known lease must be directly inside exact target.");
        string[] entries=ExactEntries(target,lease);
        byte[] buffer=MountPointBuffer(outside);
        Result result=new Result(); result.root=root; result.target=target; result.outside=outside; result.sentinel=sentinel; result.lease=lease; result.targetEntries=entries; result.inputBytes=buffer.Length;
        IntPtr write=IntPtr.Zero,attributes=IntPtr.Zero;
        try {
            write=CreateFileW(target,0x40000000,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
            int error=Marshal.GetLastWin32Error();
            result.writeHandle=write.ToInt64().ToString(System.Globalization.CultureInfo.InvariantCulture);
            result.writeOpen=Valid(write); result.writeLastErrorCaptured=error; result.writeError=result.writeOpen?0:error;
            // Close any unexpectedly successful first open before the independent
            // attribute-only attempt, so it cannot perturb the second operation.
            if(result.writeOpen) {
                result.writeClosed=CloseHandle(write); int closeError=Marshal.GetLastWin32Error();
                result.writeCloseError=result.writeClosed.Value?0:closeError;
                if(result.writeClosed.Value) write=IntPtr.Zero;
            }
            attributes=CreateFileW(target,0x100,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
            error=Marshal.GetLastWin32Error();
            result.attrHandle=attributes.ToInt64().ToString(System.Globalization.CultureInfo.InvariantCulture);
            result.attrOpen=Valid(attributes); result.attrLastErrorCaptured=error; result.attrError=result.attrOpen?0:error;
            if(result.attrOpen) {
                uint returned;
                result.setReparse=DeviceIoControl(attributes,0x000900A4,buffer,(uint)buffer.Length,IntPtr.Zero,0,out returned,IntPtr.Zero);
                int ioctlError=Marshal.GetLastWin32Error();
                result.setReparseLastErrorCaptured=ioctlError; result.setReparseError=result.setReparse.Value?0:ioctlError; result.bytesReturned=returned;
            }
        } finally {
            if(Valid(attributes)) {
                result.attrClosed=CloseHandle(attributes); int closeError=Marshal.GetLastWin32Error();
                result.attrCloseError=result.attrClosed.Value?0:closeError;
            }
            if(Valid(write)) {
                bool closed=CloseHandle(write); int closeError=Marshal.GetLastWin32Error();
                // Preserve an initial close failure even if a retry succeeds.
                if(!result.writeClosed.HasValue) { result.writeClosed=closed; result.writeCloseError=closed?0:closeError; }
            }
        }
        result.targetAttributesAfter=GetFileAttributesW(target); int attributeError=Marshal.GetLastWin32Error();
        result.targetAttributesError=result.targetAttributesAfter==UInt32.MaxValue?attributeError:0;
        return result;
    }
}
`

const directoryMutationScript =
  [
    "$ErrorActionPreference = 'Stop'",
    'Set-StrictMode -Version Latest',
    "if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSEdition -ne 'Desktop') { throw 'Mutation probe requires Windows PowerShell 5 Desktop.' }",
    "$root = [Environment]::GetEnvironmentVariable('LIFE_FIXTURE_MUTATION_ROOT')",
    "$source = [Environment]::GetEnvironmentVariable('LIFE_FIXTURE_MUTATION_SOURCE')",
    "$target = [Environment]::GetEnvironmentVariable('LIFE_FIXTURE_MUTATION_TARGET')",
    "$outside = [Environment]::GetEnvironmentVariable('LIFE_FIXTURE_MUTATION_OUTSIDE')",
    "$sentinel = [Environment]::GetEnvironmentVariable('LIFE_FIXTURE_MUTATION_SENTINEL')",
    "$lease = [Environment]::GetEnvironmentVariable('LIFE_FIXTURE_MUTATION_LEASE')",
    "foreach ($value in @($root,$source,$target,$outside,$sentinel)) { if ([String]::IsNullOrEmpty($value)) { throw 'Missing literal directory mutation environment.' } }",
    "$preRoot = [IO.Path]::GetFullPath($root).TrimEnd([char]'\\')",
    '$preSource = [IO.Path]::GetFullPath($source)',
    "if ($preRoot.Length -le 3 -or -not $preSource.StartsWith($preRoot + '\\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Mutation C# source escaped owned scratch.' }",
    'Add-Type -Path $preSource',
    '$result = [LifeFixtureDirectoryMutation]::Probe($root,$target,$outside,$sentinel,$lease)',
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    '[Console]::WriteLine((ConvertTo-Json -InputObject $result -Depth 4 -Compress))',
    '# Successful reparse mutation is diagnostic evidence, never hidden by this shim.',
    '# The Node owner decides whether it blocks adoption and cleans up after killing',
    '# and reaping the paused launcher. Only resource-close failures fail this helper.',
    "if (($null -ne $result.writeClosed -and -not [bool]$result.writeClosed) -or ($null -ne $result.attrClosed -and -not [bool]$result.attrClosed)) { throw 'Native mutation probe failed to close an acquired directory handle.' }",
    "if ($result.targetAttributesError -ne 0) { throw 'Unable to read target attributes after mutation attempt.' }",
  ].join('\n') + '\n'

const metadataScript = String.raw`$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$metadataRoot = [Environment]::GetEnvironmentVariable('LIFE_NSIS_METADATA_ROOT')
$metadataOutput = [Environment]::GetEnvironmentVariable('LIFE_NSIS_METADATA_OUTPUT')
$metadataAction = [Environment]::GetEnvironmentVariable('LIFE_NSIS_METADATA_ACTION')
if ([String]::IsNullOrEmpty($metadataRoot) -or [String]::IsNullOrEmpty($metadataOutput)) { throw 'Missing metadata fixture environment.' }
$metadataRoot = [IO.Path]::GetFullPath($metadataRoot).TrimEnd([char]'\')
if ($metadataRoot.Length -le 3) { throw 'Fixture must not customize or snapshot a volume root.' }
$rootItem = Get-Item -LiteralPath $metadataRoot -Force
if (-not $rootItem.PSIsContainer -or ([Int64]$rootItem.Attributes -band 0x400) -ne 0) { throw 'Metadata fixture root must be an ordinary directory.' }

# Windows PowerShell 5 cannot reliably enumerate directory ADS through -Stream.
# .NET Framework path constructors also reject ADS colons. Use native handles
# for stream creation and reads, and preserve immediate native error capture.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class LifeFixtureStreams {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  private struct StreamData {
    public long Size;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=296)]
    public string Name;
  }
  public sealed class Entry { public string Name; public long Size; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  private static extern IntPtr FindFirstStreamW(string path, int level, out StreamData data, uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool FindNextStreamW(IntPtr handle, out StreamData data);
  [DllImport("kernel32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool FindClose(IntPtr handle);
  private static FileStream Open(string path, bool write) {
    SafeFileHandle handle = CreateFileW(path, write ? 0x40000000u : 0x80000000u, 1, IntPtr.Zero, write ? 2u : 3u, 0x02000080u, IntPtr.Zero);
    int error = Marshal.GetLastWin32Error();
    if (handle.IsInvalid) {
      handle.Dispose();
      throw new Win32Exception(error, "Native fixture stream open failed");
    }
    try { return new FileStream(handle, write ? FileAccess.Write : FileAccess.Read, 4096, false); }
    catch { handle.Dispose(); throw; }
  }
  public static FileStream OpenRead(string path) { return Open(path, false); }
  public static void WriteNamedStream(string path, string name, byte[] bytes) {
    if (String.IsNullOrEmpty(name) || name.IndexOfAny(new char[] { ':', '\\', '/' }) >= 0 || bytes == null || bytes.Length > 8388608) throw new ArgumentException("Invalid fixture stream write");
    using (FileStream stream = Open(path + ":" + name, true)) {
      stream.Write(bytes, 0, bytes.Length);
      stream.Flush(true);
      if (stream.Position != bytes.Length || stream.Length != bytes.Length) throw new IOException("Native fixture stream write was incomplete");
    }
  }
  public static byte[] ReadBytes(string path) {
    using (FileStream stream = OpenRead(path)) {
      if (stream.Length < 0 || stream.Length > 8388608) throw new InvalidOperationException("Fixture stream read exceeds bounds");
      byte[] result = new byte[(int)stream.Length];
      int offset = 0;
      while (offset < result.Length) {
        int read = stream.Read(result, offset, result.Length - offset);
        if (read == 0) throw new EndOfStreamException("Fixture stream ended unexpectedly");
        offset += read;
      }
      if (stream.ReadByte() != -1) throw new IOException("Fixture stream changed during read");
      return result;
    }
  }
  public static void RequireMissingStream(string path) {
    try { using (FileStream stream = OpenRead(path)) {} }
    catch (Win32Exception error) {
      if (error.NativeErrorCode == 2 || error.NativeErrorCode == 3) return;
      throw;
    }
    throw new InvalidOperationException("Missing fixture stream unexpectedly opened");
  }
  public static Entry[] Read(string path) {
    StreamData data;
    IntPtr handle = FindFirstStreamW(path, 0, out data, 0);
    int firstError = Marshal.GetLastWin32Error();
    if (handle == new IntPtr(-1)) {
      if (firstError == 38) return new Entry[0];
      throw new Win32Exception(firstError, "FindFirstStreamW failed");
    }
    List<Entry> result = new List<Entry>();
    int count = 0;
    try {
      while (true) {
        if (++count > 17 || data.Size < 0) throw new InvalidOperationException("Fixture streams exceed bounds");
        if (data.Name != "::$DATA") {
          if (!data.Name.StartsWith(":", StringComparison.Ordinal) || !data.Name.EndsWith(":$DATA", StringComparison.Ordinal)) throw new InvalidOperationException("Unexpected stream type");
          result.Add(new Entry { Name = data.Name.Substring(1, data.Name.Length - 7), Size = data.Size });
        }
        if (!FindNextStreamW(handle, out data)) {
          int nextError = Marshal.GetLastWin32Error();
          if (nextError != 38) throw new Win32Exception(nextError, "FindNextStreamW failed");
          break;
        }
      }
    } finally {
      if (!FindClose(handle)) throw new Win32Exception(Marshal.GetLastWin32Error(), "FindClose stream failed");
    }
    return result.ToArray();
  }
}
'@

function Get-FixtureHash([String]$filename) {
  $hash = [Security.Cryptography.SHA256]::Create()
  $handle = $null
  try {
    $handle = [LifeFixtureStreams]::OpenRead($filename)
    if ($handle.Length -gt 16MB) { throw 'Fixture stream or file exceeds the hashing limit.' }
    return ([BitConverter]::ToString($hash.ComputeHash($handle))).Replace('-', '').ToLowerInvariant()
  } finally {
    if ($null -ne $handle) { $handle.Dispose() }
    $hash.Dispose()
  }
}

if ($metadataAction -eq 'customize' -or $metadataAction -eq 'probe-ads') {
  if (@(Get-ChildItem -LiteralPath $metadataRoot -Force).Count -ne 0) { throw 'Custom metadata must be prepared on an empty fixture target.' }
  if ($metadataAction -eq 'customize') {
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $customAcl = Get-Acl -LiteralPath $metadataRoot
    $customAcl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($customAcl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))) {
      [void]$customAcl.RemoveAccessRuleSpecific($rule)
    }
    $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    $customAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($currentSid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
    $customAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'), [Security.AccessControl.FileSystemRights]::ReadAndExecute, $inheritance, [Security.AccessControl.PropagationFlags]::InheritOnly, [Security.AccessControl.AccessControlType]::Allow))
    Set-Acl -LiteralPath $metadataRoot -AclObject $customAcl
  }
  [byte[]]$sentinel = ([Text.UTF8Encoding]::new($false)).GetBytes('Life root stream sentinel')
  [LifeFixtureStreams]::WriteNamedStream($metadataRoot, 'life-fixture-root', $sentinel)
  [byte[]]$readBack = [LifeFixtureStreams]::ReadBytes($metadataRoot + ':life-fixture-root')
  if ([Convert]::ToBase64String($readBack) -cne [Convert]::ToBase64String($sentinel)) { throw 'Native directory ADS exact-byte roundtrip failed.' }
  $sentinelHash = [Security.Cryptography.SHA256]::Create()
  try { $expectedHash = ([BitConverter]::ToString($sentinelHash.ComputeHash($sentinel))).Replace('-', '').ToLowerInvariant() }
  finally { $sentinelHash.Dispose() }
  if ((Get-FixtureHash ($metadataRoot + ':life-fixture-root')) -cne $expectedHash) { throw 'Native directory ADS hash proof failed.' }
  if ($metadataAction -eq 'probe-ads') { [LifeFixtureStreams]::RequireMissingStream($metadataRoot + ':life-fixture-missing') }
  $sentinelEntries = @([LifeFixtureStreams]::Read($metadataRoot) | Where-Object { $_.Name -ceq 'life-fixture-root' })
  if ($sentinelEntries.Count -ne 1 -or $sentinelEntries[0].Size -ne $sentinel.Length) { throw 'Native directory ADS enumeration proof failed.' }
} elseif ($metadataAction -ne 'snapshot') { throw 'Unsupported metadata fixture action.' }

$pending = [Collections.Generic.Stack[Object]]::new()
$pending.Push([PSCustomObject]@{ Item = (Get-Item -LiteralPath $metadataRoot -Force); Relative = ''; Depth = 0 })
$records = [Collections.Generic.List[Object]]::new()
$streamTotal = [Int64]0
while ($pending.Count -gt 0) {
  $pendingItem = $pending.Pop()
  $item = $pendingItem.Item
  if ($pendingItem.Depth -gt 16 -or $records.Count -ge 128) { throw 'Fixture inventory exceeds bounds.' }
  if (([Int64]$item.Attributes -band 0x400) -ne 0) { throw 'Metadata snapshot refuses reparse points.' }
  $acl = Get-Acl -LiteralPath $item.FullName
  $aceRecords = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {
    [PSCustomObject][ordered]@{
      Sid = $_.IdentityReference.Value
      Type = [Int32]$_.AccessControlType
      Rights = [Int64]$_.FileSystemRights
      Inheritance = [Int32]$_.InheritanceFlags
      Propagation = [Int32]$_.PropagationFlags
      IsInherited = $_.IsInherited
    }
  } | Sort-Object Sid, Type, Rights, Inheritance, Propagation, IsInherited)
  $streams = @()
  foreach ($stream in @([LifeFixtureStreams]::Read($item.FullName))) {
    $streamTotal += $stream.Size
    if ($streamTotal -gt 8MB -or $streams.Count -ge 16) { throw 'Fixture ADS inventory exceeds bounds.' }
    $streams += [PSCustomObject][ordered]@{ Name = $stream.Name; Size = [Int64]$stream.Size; Sha256 = Get-FixtureHash ($item.FullName + ':' + $stream.Name) }
  }
  $record = [PSCustomObject][ordered]@{
    Relative = $pendingItem.Relative
    Directory = [Bool]$item.PSIsContainer
    Attributes = [Int64]$item.Attributes
    FileSha256 = $(if ($item.PSIsContainer) { $null } else { Get-FixtureHash $item.FullName })
    FileLastWriteUtcTicks = $(if ($item.PSIsContainer) { $null } else { $item.LastWriteTimeUtc.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) })
    DirectoryLastWriteUtcTicksInformational = $(if ($item.PSIsContainer) { $item.LastWriteTimeUtc.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) } else { $null })
    OwnerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    GroupSid = $acl.GetGroup([Security.Principal.SecurityIdentifier]).Value
    DaclProtected = $acl.AreAccessRulesProtected
    DaclCanonical = $acl.AreAccessRulesCanonical
    Aces = $aceRecords
    Streams = @($streams | Sort-Object Name)
  }
  $records.Add($record)
  if ($item.PSIsContainer) {
    foreach ($child in @(Get-ChildItem -LiteralPath $item.FullName -Force)) {
      $relative = $(if ($pendingItem.Relative -eq '') { $child.Name } else { $pendingItem.Relative + '/' + $child.Name })
      $pending.Push([PSCustomObject]@{ Item = $child; Relative = $relative; Depth = $pendingItem.Depth + 1 })
    }
  }
}
$json = ConvertTo-Json -InputObject @($records | Sort-Object Relative) -Depth 12 -Compress
[IO.File]::WriteAllText($metadataOutput, $json, [Text.UTF8Encoding]::new($false))`

const accessDeniedScript = String.raw`$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$rawRoot = $env:LIFE_ACL_FIXTURE_ROOT
$rawFile = $env:LIFE_ACL_FIXTURE_FILE
$rawScratch = $env:LIFE_ACL_FIXTURE_SCRATCH
$sections = [Security.AccessControl.AccessControlSections]::Access
$identitySections = [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class LifeFixtureAttributes {
  public sealed class Result { public long Attributes; public int Error; }
  public sealed class FileRead { public long Length; public string Sha256; }
  public sealed class AccessRead { public int Control; public string OrderedDacl; public string Access; public string Identity; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  private static extern uint GetFileAttributesW(string path);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  private static extern uint GetFullPathNameW(string path, uint size, StringBuilder buffer, IntPtr filePart);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint revision, out IntPtr descriptor, out uint size);
  [DllImport("advapi32.dll", ExactSpelling=true, SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetSecurityDescriptorDacl(IntPtr descriptor, [MarshalAs(UnmanagedType.Bool)] out bool present, out IntPtr dacl, [MarshalAs(UnmanagedType.Bool)] out bool defaulted);
  [DllImport("advapi32.dll", ExactSpelling=true, SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetSecurityDescriptorControl(IntPtr descriptor, out ushort control, out uint revision);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, ExactSpelling=true)]
  private static extern uint SetNamedSecurityInfoW(string path, int objectType, uint information, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, ExactSpelling=true)]
  private static extern uint GetNamedSecurityInfoW(string path, int objectType, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
  [DllImport("advapi32.dll", ExactSpelling=true)]
  private static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("kernel32.dll", ExactSpelling=true, SetLastError=true)]
  private static extern IntPtr LocalFree(IntPtr memory);
  public static string NormalizePath(string path) {
    if (String.IsNullOrEmpty(path) || path.Length >= 32768 || path.Length < 3 || !((path[0] >= 'A' && path[0] <= 'Z') || (path[0] >= 'a' && path[0] <= 'z')) || path[1] != ':' || (path[2] != '\\' && path[2] != '/') || path.IndexOf('\0') >= 0 || path.IndexOf(':', 2) >= 0) throw new ArgumentException("ACL fixture paths must be bounded absolute drive paths");
    foreach (char value in path) {
      if (value < 32 || value == '"' || value == '<' || value == '>' || value == '|' || value == '*' || value == '?') throw new ArgumentException("ACL fixture paths contain unsupported characters");
    }
    StringBuilder buffer = new StringBuilder(32768);
    uint count = GetFullPathNameW(path, (uint)buffer.Capacity, buffer, IntPtr.Zero);
    int error = Marshal.GetLastWin32Error();
    if (count == 0) throw new Win32Exception(error, "Native fixture path normalization failed");
    if (count >= buffer.Capacity || buffer.Length != count) throw new InvalidOperationException("Native fixture path normalization exceeds bounds");
    string result = buffer.ToString();
    if (result.Length < 3 || result[1] != ':' || result[2] != '\\') throw new InvalidOperationException("Normalized fixture path is not drive-absolute");
    return result;
  }
  public static Result Read(string path) {
    uint attributes = GetFileAttributesW(path);
    int error = Marshal.GetLastWin32Error();
    return new Result { Attributes = unchecked((int)attributes), Error = error };
  }
  public static FileRead ReadFile(string path) {
    SafeFileHandle handle = CreateFileW(path, 0x80000000u, 1, IntPtr.Zero, 3, 0x80, IntPtr.Zero);
    int error = Marshal.GetLastWin32Error();
    if (handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(error, "Native fixture file read open failed"); }
    FileStream stream;
    try { stream = new FileStream(handle, FileAccess.Read, 4096, false); }
    catch { handle.Dispose(); throw; }
    using (stream)
    using (SHA256 hash = SHA256.Create()) {
      long length = stream.Length;
      if (length < 0 || length > 1048576) throw new InvalidOperationException("ACL fixture file exceeds read bounds");
      string sha256 = BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
      if (stream.Position != length || stream.Length != length) throw new IOException("ACL fixture file changed during native read");
      return new FileRead { Length = length, Sha256 = sha256 };
    }
  }
  public static AccessRead ReadAccess(string path) {
    IntPtr owner, group, namedDacl, sacl;
    IntPtr descriptor = IntPtr.Zero;
    uint status = GetNamedSecurityInfoW(path, 1, 7, out owner, out group, out namedDacl, out sacl, out descriptor);
    Exception failure = null;
    AccessRead result = null;
    try {
      if (status != 0) throw new Win32Exception(unchecked((int)status), "Native fixture DACL read failed: " + path);
      if (descriptor == IntPtr.Zero) throw new InvalidOperationException("Native fixture descriptor is absent");
      ushort control;
      uint revision;
      bool gotControl = GetSecurityDescriptorControl(descriptor, out control, out revision);
      int controlError = Marshal.GetLastWin32Error();
      if (!gotControl) throw new Win32Exception(controlError, "Native fixture DACL control read failed");
      if (revision != 1 || (control & 0x8000) == 0) throw new InvalidOperationException("Native fixture descriptor must be self-relative revision 1");
      uint size = GetSecurityDescriptorLength(descriptor);
      if (size < 20 || size > 65536) throw new InvalidOperationException("Native fixture descriptor exceeds bounds");
      bool present, defaulted;
      IntPtr dacl;
      bool gotDacl = GetSecurityDescriptorDacl(descriptor, out present, out dacl, out defaulted);
      int daclError = Marshal.GetLastWin32Error();
      if (!gotDacl) throw new Win32Exception(daclError, "Native fixture raw DACL lookup failed");
      if (!present || dacl == IntPtr.Zero || dacl != namedDacl) throw new InvalidOperationException("Native fixture DACL is absent, NULL or inconsistent");
      long offset = dacl.ToInt64() - descriptor.ToInt64();
      if (offset < 20 || offset > size - 8) throw new InvalidOperationException("Native fixture raw DACL lies outside descriptor");
      int aclSize = unchecked((ushort)Marshal.ReadInt16(dacl, 2));
      if (aclSize < 8 || offset + aclSize > size) throw new InvalidOperationException("Native fixture raw DACL exceeds descriptor bounds");
      byte[] orderedDacl = new byte[aclSize];
      Marshal.Copy(dacl, orderedDacl, 0, orderedDacl.Length);
      byte[] bytes = new byte[(int)size];
      Marshal.Copy(descriptor, bytes, 0, bytes.Length);
      RawSecurityDescriptor raw = new RawSecurityDescriptor(bytes, 0);
      result = new AccessRead {
        Control = control, OrderedDacl = Convert.ToBase64String(orderedDacl),
        Access = raw.GetSddlForm(AccessControlSections.Access),
        Identity = raw.GetSddlForm(AccessControlSections.Owner | AccessControlSections.Group)
      };
    } catch (Exception error) { failure = error; }
    finally {
      if (descriptor != IntPtr.Zero) {
        IntPtr remaining = LocalFree(descriptor);
        int freeError = Marshal.GetLastWin32Error();
        if (remaining != IntPtr.Zero) {
          Exception freeFailure = new Win32Exception(freeError, "Native fixture read descriptor release failed");
          failure = failure == null ? freeFailure : new AggregateException("DACL read and descriptor release failed", failure, freeFailure);
        }
      }
    }
    if (failure != null) throw failure;
    return result;
  }
  public static void ValidateAccess(string sddl) { AccessDescriptor(null, sddl, false); }
  public static void RestoreAccess(string path, string sddl) { AccessDescriptor(path, sddl, true); }
  private static void AccessDescriptor(string path, string sddl, bool restore) {
    if (String.IsNullOrEmpty(sddl) || sddl.Length > 65536) throw new ArgumentException("Invalid saved fixture DACL");
    IntPtr descriptor = IntPtr.Zero;
    uint size;
    bool converted = ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out descriptor, out size);
    int conversionError = Marshal.GetLastWin32Error();
    Exception failure = null;
    try {
      if (!converted) throw new Win32Exception(conversionError, "Saved fixture DACL conversion failed");
      if (descriptor == IntPtr.Zero || size < 20 || size > 65536) throw new InvalidOperationException("Saved fixture security descriptor exceeds bounds");
      bool present, defaulted;
      IntPtr dacl;
      bool gotDacl = GetSecurityDescriptorDacl(descriptor, out present, out dacl, out defaulted);
      int daclError = Marshal.GetLastWin32Error();
      if (!gotDacl) throw new Win32Exception(daclError, "Saved fixture DACL lookup failed");
      if (!present || dacl == IntPtr.Zero) throw new InvalidOperationException("Fixture restoration refuses an absent or NULL DACL");
      long offset = dacl.ToInt64() - descriptor.ToInt64();
      if (offset < 20 || offset > size - 8) throw new InvalidOperationException("Saved fixture DACL lies outside its descriptor");
      int aclSize = unchecked((ushort)Marshal.ReadInt16(dacl, 2));
      if (aclSize < 8 || offset + aclSize > size) throw new InvalidOperationException("Saved fixture DACL exceeds descriptor bounds");
      ushort control;
      uint revision;
      bool gotControl = GetSecurityDescriptorControl(descriptor, out control, out revision);
      int controlError = Marshal.GetLastWin32Error();
      if (!gotControl) throw new Win32Exception(controlError, "Saved fixture DACL control lookup failed");
      if (revision != 1) throw new InvalidOperationException("Unexpected saved fixture descriptor revision");
      uint information = 4u | ((control & 0x1000) != 0 ? 0x80000000u : 0x20000000u);
      if (restore) {
        uint status = SetNamedSecurityInfoW(path, 1, information, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
        if (status != 0) throw new Win32Exception(unchecked((int)status), "Native saved fixture DACL restoration failed: " + path);
      }
    } catch (Exception error) { failure = error; }
    finally {
      if (descriptor != IntPtr.Zero) {
        IntPtr remaining = LocalFree(descriptor);
        int freeError = Marshal.GetLastWin32Error();
        if (remaining != IntPtr.Zero) {
          Exception freeFailure = new Win32Exception(freeError, "Saved fixture descriptor release failed");
          failure = failure == null ? freeFailure : new AggregateException("DACL restoration and descriptor release failed", failure, freeFailure);
        }
      }
    }
    if (failure != null) throw failure;
  }
}
'@
$fixtureRoot = [LifeFixtureAttributes]::NormalizePath($rawRoot).TrimEnd([char]'\')
$fixtureFile = [LifeFixtureAttributes]::NormalizePath($rawFile)
$fixtureParent = $fixtureFile.Substring(0, $fixtureFile.LastIndexOf([char]'\'))
$scratchRoot = [LifeFixtureAttributes]::NormalizePath($rawScratch).TrimEnd([char]'\')
$fixturePaths = [ordered]@{ Root = $fixtureRoot; File = $fixtureFile; Parent = $fixtureParent; Scratch = $scratchRoot }
[Console]::Error.WriteLine('Fixture ACL scope before containment: ' + (ConvertTo-Json -InputObject ([ordered]@{ RawRoot = $rawRoot; RawFile = $rawFile; RawScratch = $rawScratch; Normalized = $fixturePaths }) -Compress))
if ($scratchRoot.Length -le 3 -or $fixtureRoot.Length -le 3 -or -not $fixtureRoot.StartsWith(($scratchRoot + '\'), [StringComparison]::OrdinalIgnoreCase) -or -not $fixtureFile.StartsWith(($fixtureRoot + '\'), [StringComparison]::OrdinalIgnoreCase) -or $fixtureParent.Equals($fixtureRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Access denial must be confined to a nested, fixture-owned payload path.' }
function Assert-FixturePathNormalization([String]$phase) {
  $againFile = [LifeFixtureAttributes]::NormalizePath($rawFile)
  $again = [ordered]@{
    Root = [LifeFixtureAttributes]::NormalizePath($rawRoot).TrimEnd([char]'\')
    File = $againFile
    Parent = $againFile.Substring(0, $againFile.LastIndexOf([char]'\'))
    Scratch = [LifeFixtureAttributes]::NormalizePath($rawScratch).TrimEnd([char]'\')
  }
  foreach ($key in @('Root', 'File', 'Parent', 'Scratch')) {
    if ($again[$key] -cne $fixturePaths[$key]) { throw ('Native fixture path normalization changed during ' + $phase) }
  }
  [Console]::Error.WriteLine('Fixture ACL native normalization ' + $phase + ': ' + (ConvertTo-Json -InputObject $again -Compress))
}
function Get-FixtureAclState {
  $rootAttributes = [LifeFixtureAttributes]::Read($fixtureRoot)
  $parentAttributes = [LifeFixtureAttributes]::Read($fixtureParent)
  $fileAttributes = [LifeFixtureAttributes]::Read($fixtureFile)
  foreach ($ordinary in @($rootAttributes, $parentAttributes)) {
    if ($ordinary.Attributes -eq -1 -or ($ordinary.Attributes -band 0x410) -ne 0x10) { throw 'ACL preparation requires ordinary owned directories.' }
  }
  if ($fileAttributes.Attributes -eq -1 -or ($fileAttributes.Attributes -band 0x410) -ne 0) { throw 'ACL preparation requires an ordinary expected file.' }
  $entries = @([IO.Directory]::GetFileSystemEntries($fixtureParent) | ForEach-Object { [IO.Path]::GetFileName($_) } | Sort-Object)
  if ($entries.Count -ne 1 -or $entries[0] -cne [IO.Path]::GetFileName($fixtureFile)) { throw 'ACL preparation parent must contain only the expected ordinary file.' }
  $parent = [LifeFixtureAttributes]::ReadAccess($fixtureParent)
  $file = [LifeFixtureAttributes]::ReadAccess($fixtureFile)
  $read = [LifeFixtureAttributes]::ReadFile($fixtureFile)
  return [PSCustomObject][ordered]@{
    ParentAccess = $parent.Access; FileAccess = $file.Access
    ParentControl = $parent.Control; FileControl = $file.Control
    ParentOrderedDacl = $parent.OrderedDacl; FileOrderedDacl = $file.OrderedDacl
    ParentIdentity = $parent.Identity; FileIdentity = $file.Identity
    ParentAttributes = $parentAttributes.Attributes; FileAttributes = $fileAttributes.Attributes
    ParentEntries = $entries; FileLength = $read.Length; FileSha256 = $read.Sha256
  }
}
if ($env:LIFE_ACL_FIXTURE_ACTION -eq 'probe-path') {
  Assert-FixturePathNormalization 'path-only probe'
  $result = [PSCustomObject]@{ Paths = $fixturePaths; PathNormalizationStable = $true }
} elseif ($env:LIFE_ACL_FIXTURE_ACTION -eq 'prepare-acl') {
  # Explicitly initialize the owned fixture to Windows' documented current
  # inheritance model BEFORE taking the denial/restoration baseline.
  # Both objects are observed before the parent can propagate any changes.
  $beforePreparation = Get-FixtureAclState
  [LifeFixtureAttributes]::ValidateAccess($beforePreparation.ParentAccess)
  [LifeFixtureAttributes]::ValidateAccess($beforePreparation.FileAccess)
  [LifeFixtureAttributes]::RestoreAccess($fixtureParent, $beforePreparation.ParentAccess)
  [LifeFixtureAttributes]::RestoreAccess($fixtureFile, $beforePreparation.FileAccess)
  $afterPreparation = Get-FixtureAclState
  [Console]::Error.WriteLine('Fixture ACL explicit preparation before saved baseline: ' + (ConvertTo-Json -InputObject ([ordered]@{ Before = $beforePreparation; After = $afterPreparation }) -Depth 6 -Compress))
  foreach ($name in @('ParentControl', 'FileControl')) {
    if ($afterPreparation.$name -ne ($beforePreparation.$name -bor 0x0400)) { throw 'ACL preparation may only establish the documented AI control flag.' }
  }
  foreach ($name in @('ParentOrderedDacl', 'FileOrderedDacl', 'ParentIdentity', 'FileIdentity', 'ParentAttributes', 'FileAttributes', 'FileLength', 'FileSha256')) {
    if ($afterPreparation.$name -cne $beforePreparation.$name) { throw ('ACL preparation changed existing metadata: ' + $name) }
  }
  if ((ConvertTo-Json -InputObject $afterPreparation.ParentEntries -Compress) -cne (ConvertTo-Json -InputObject $beforePreparation.ParentEntries -Compress)) { throw 'ACL preparation changed directory enumeration.' }
  [LifeFixtureAttributes]::RestoreAccess($fixtureParent, $afterPreparation.ParentAccess)
  [LifeFixtureAttributes]::RestoreAccess($fixtureFile, $afterPreparation.FileAccess)
  $afterRepeat = Get-FixtureAclState
  [Console]::Error.WriteLine('Fixture ACL repeated preparation stability: ' + (ConvertTo-Json -InputObject ([ordered]@{ Before = $afterPreparation; After = $afterRepeat }) -Depth 6 -Compress))
  if ((ConvertTo-Json -InputObject $afterRepeat -Depth 6 -Compress) -cne (ConvertTo-Json -InputObject $afterPreparation -Depth 6 -Compress)) { throw 'ACL preparation must be exactly stable on repeat.' }
  Assert-FixturePathNormalization 'after explicit ACL preparation'
  $result = [PSCustomObject]@{ Before = $beforePreparation; After = $afterPreparation; Repeat = $afterRepeat; Paths = $fixturePaths; PathNormalizationStable = $true }
} elseif ($env:LIFE_ACL_FIXTURE_ACTION -eq 'apply') {
  foreach ($ordinary in @($fixtureRoot, $fixtureParent)) {
    $attributes = [LifeFixtureAttributes]::Read($ordinary)
    if ($attributes.Attributes -eq -1 -or ($attributes.Attributes -band 0x10) -eq 0 -or ($attributes.Attributes -band 0x400) -ne 0) { throw 'Access denial requires ordinary fixture directories.' }
  }
  $beforeFile = [LifeFixtureAttributes]::Read($fixtureFile)
  $beforeParent = [LifeFixtureAttributes]::Read($fixtureParent)
  if ($beforeFile.Attributes -eq -1 -or ($beforeFile.Attributes -band 0x410) -ne 0) { throw 'Access denial requires an ordinary expected file.' }
  $parentAcl = [IO.Directory]::GetAccessControl($fixtureParent)
  $fileAcl = [IO.File]::GetAccessControl($fixtureFile)
  $baselineState = Get-FixtureAclState
  $beforeRead = [LifeFixtureAttributes]::ReadFile($fixtureFile)
  $beforeEntries = @([IO.Directory]::GetFileSystemEntries($fixtureParent) | ForEach-Object { [IO.Path]::GetFileName($_) } | Sort-Object)
  if ($beforeEntries.Count -gt 16) { throw 'ACL fixture directory exceeds enumeration bounds.' }
  $backup = [PSCustomObject]@{
    Parent = $fixtureParent; File = $fixtureFile; Sid = $currentSid.Value
    ParentAccess = $parentAcl.GetSecurityDescriptorSddlForm($sections)
    FileAccess = $fileAcl.GetSecurityDescriptorSddlForm($sections)
    ParentIdentity = $parentAcl.GetSecurityDescriptorSddlForm($identitySections)
    FileIdentity = $fileAcl.GetSecurityDescriptorSddlForm($identitySections)
    FileAttributes = $beforeFile.Attributes
    ParentAttributes = $beforeParent.Attributes
    FileLength = $beforeRead.Length; FileSha256 = $beforeRead.Sha256
    ParentEntries = $beforeEntries
    NativeBaseline = $baselineState
  }
  [LifeFixtureAttributes]::ValidateAccess($backup.ParentAccess)
  [LifeFixtureAttributes]::ValidateAccess($backup.FileAccess)
  [IO.File]::WriteAllText($env:LIFE_ACL_FIXTURE_BACKUP, (ConvertTo-Json -InputObject $backup -Depth 6 -Compress), [Text.UTF8Encoding]::new($false))
  Assert-FixturePathNormalization 'before access denial'
  # NTFS also exposes a child's attributes through parent directory listing.
  # Deny both independent rights, without denying traversal or WRITE_DAC.
  $parentAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($currentSid, [Security.AccessControl.FileSystemRights]::ListDirectory, [Security.AccessControl.InheritanceFlags]::None, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Deny))
  $fileAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($currentSid, [Security.AccessControl.FileSystemRights]::ReadAttributes, [Security.AccessControl.InheritanceFlags]::None, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Deny))
  [IO.File]::SetAccessControl($fixtureFile, $fileAcl)
  [IO.Directory]::SetAccessControl($fixtureParent, $parentAcl)
  $denied = [LifeFixtureAttributes]::Read($fixtureFile)
  if ($denied.Attributes -ne -1 -or $denied.Error -ne 5) { throw ('Expected actual native GetFileAttributesW access denial, got attributes=' + $denied.Attributes + ', error=' + $denied.Error) }
  Assert-FixturePathNormalization 'after actual native access denial'
  $result = [PSCustomObject]@{ Attributes = $denied.Attributes; Error = $denied.Error; Sid = $currentSid.Value; Paths = $fixturePaths; PathNormalizationStable = $true; NativeBaseline = $baselineState }
} elseif ($env:LIFE_ACL_FIXTURE_ACTION -eq 'restore') {
  $backup = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($env:LIFE_ACL_FIXTURE_BACKUP))
  if ($backup.Parent -cne $fixtureParent -or $backup.File -cne $fixtureFile -or $backup.Sid -cne $currentSid.Value) { throw 'ACL backup paths or identity do not match this owned fixture.' }
  $diagnostics = [ordered]@{ SavedParentAccess = $backup.ParentAccess; SavedFileAccess = $backup.FileAccess; CurrentParentAccess = $null; CurrentFileAccess = $null; ParentReadError = $null; FileReadError = $null }
  try { $diagnostics.CurrentParentAccess = ([IO.Directory]::GetAccessControl($fixtureParent)).GetSecurityDescriptorSddlForm($sections) } catch { $diagnostics.ParentReadError = $_.Exception.ToString() }
  try { $diagnostics.CurrentFileAccess = ([IO.File]::GetAccessControl($fixtureFile)).GetSecurityDescriptorSddlForm($sections) } catch { $diagnostics.FileReadError = $_.Exception.ToString() }
  [Console]::Error.WriteLine('Fixture ACL restoration before native writes: ' + (ConvertTo-Json -InputObject $diagnostics -Compress))
  # Restore the parent first so any inheritance propagation precedes the final
  # exact file DACL restoration. Native calls set only the saved Access section.
  $restoreFailures = @()
  try { [LifeFixtureAttributes]::RestoreAccess($fixtureParent, $backup.ParentAccess) } catch { $restoreFailures += $_.Exception.ToString() }
  try { [LifeFixtureAttributes]::RestoreAccess($fixtureFile, $backup.FileAccess) } catch { $restoreFailures += $_.Exception.ToString() }
  if ($restoreFailures.Count -gt 0) { throw ('Fixture ACL restoration failed: ' + ($restoreFailures -join '; ')) }
  $restoredFile = [IO.File]::GetAccessControl($fixtureFile)
  $restoredParent = [IO.Directory]::GetAccessControl($fixtureParent)
  $afterDiagnostics = [ordered]@{
    SavedParentAccess = $backup.ParentAccess; RestoredParentAccess = $restoredParent.GetSecurityDescriptorSddlForm($sections)
    SavedFileAccess = $backup.FileAccess; RestoredFileAccess = $restoredFile.GetSecurityDescriptorSddlForm($sections)
    SavedParentIdentity = $backup.ParentIdentity; RestoredParentIdentity = $restoredParent.GetSecurityDescriptorSddlForm($identitySections)
    SavedFileIdentity = $backup.FileIdentity; RestoredFileIdentity = $restoredFile.GetSecurityDescriptorSddlForm($identitySections)
  }
  [Console]::Error.WriteLine('Fixture ACL restoration after native writes: ' + (ConvertTo-Json -InputObject $afterDiagnostics -Compress))
  if ($restoredFile.GetSecurityDescriptorSddlForm($sections) -cne $backup.FileAccess -or $restoredParent.GetSecurityDescriptorSddlForm($sections) -cne $backup.ParentAccess -or $restoredFile.GetSecurityDescriptorSddlForm($identitySections) -cne $backup.FileIdentity -or $restoredParent.GetSecurityDescriptorSddlForm($identitySections) -cne $backup.ParentIdentity) { throw 'Access denial cleanup did not restore the exact DACL, owner and group.' }
  $restoredAttributes = [LifeFixtureAttributes]::Read($fixtureFile)
  $restoredParentAttributes = [LifeFixtureAttributes]::Read($fixtureParent)
  if ($restoredAttributes.Attributes -ne $backup.FileAttributes) { throw 'Access denial cleanup did not restore native attribute access.' }
  if ($restoredParentAttributes.Attributes -ne $backup.ParentAttributes) { throw 'Access denial cleanup did not restore exact parent native attributes.' }
  $restoredEntries = @([IO.Directory]::GetFileSystemEntries($fixtureParent) | ForEach-Object { [IO.Path]::GetFileName($_) } | Sort-Object)
  if ($restoredEntries.Count -ne @($backup.ParentEntries).Count -or [String]::Join([char]0, [String[]]$restoredEntries) -cne [String]::Join([char]0, [String[]]$backup.ParentEntries)) { throw 'Access denial cleanup did not restore exact directory enumeration.' }
  $restoredRead = [LifeFixtureAttributes]::ReadFile($fixtureFile)
  if ($restoredRead.Length -ne $backup.FileLength -or $restoredRead.Sha256 -cne $backup.FileSha256) { throw 'Access denial cleanup did not restore exact native file read/hash.' }
  $restoredNativeState = Get-FixtureAclState
  [Console]::Error.WriteLine('Fixture ACL exact native baseline restoration: ' + (ConvertTo-Json -InputObject ([ordered]@{ Saved = $backup.NativeBaseline; Restored = $restoredNativeState }) -Depth 6 -Compress))
  if ((ConvertTo-Json -InputObject $restoredNativeState -Depth 6 -Compress) -cne (ConvertTo-Json -InputObject $backup.NativeBaseline -Depth 6 -Compress)) { throw 'Access denial cleanup did not restore every exact native baseline field.' }
  Assert-FixturePathNormalization 'after exact ACL restoration'
  $result = [PSCustomObject]@{ Restored = $true; Attributes = $restoredAttributes.Attributes; ParentAttributes = $restoredParentAttributes.Attributes; Sid = $currentSid.Value; DirectoryEntries = $restoredEntries; FileLength = $restoredRead.Length; FileSha256 = $restoredRead.Sha256; Paths = $fixturePaths; PathNormalizationStable = $true; NativeRestored = $restoredNativeState }
} else { throw 'Unsupported access denial fixture action.' }
[IO.File]::WriteAllText($env:LIFE_ACL_FIXTURE_OUTPUT, (ConvertTo-Json -InputObject $result -Compress), [Text.UTF8Encoding]::new($false))`

const immediate = () => new Promise((resolve) => setImmediate(resolve))

function reportFixtureFailure(
  error,
  label = 'Native payload fixture failure',
  write = console.error,
  seen = new Set(),
) {
  write(`${label}:\n${error?.stack ?? String(error)}`)
  if (seen.has(error)) return
  seen.add(error)
  if (error instanceof AggregateError) {
    error.errors.forEach((inner, index) =>
      reportFixtureFailure(inner, `${label} [${index + 1}]`, write, seen),
    )
  }
}

function finishFixtureCleanup(primaryFailure, cleanup, stage, report = reportFixtureFailure) {
  let cleanupFailure
  try {
    cleanup()
  } catch (error) {
    cleanupFailure = error
  }
  if (primaryFailure !== undefined) report(primaryFailure, `Original failure before ${stage}`)
  if (cleanupFailure !== undefined) report(cleanupFailure, `${stage} failure`)
  if (primaryFailure !== undefined && cleanupFailure !== undefined) {
    throw new AggregateError(
      [primaryFailure, cleanupFailure],
      `${stage} failed after an earlier fixture failure`,
      {
        cause: primaryFailure,
      },
    )
  }
  if (primaryFailure !== undefined) throw primaryFailure
  if (cleanupFailure !== undefined) throw cleanupFailure
}

function verifyFixtureCleanup() {
  const primary = new Error('Owned primary fixture probe')
  const cleanup = new Error('Owned cleanup fixture probe')
  const reports = []
  const report = (error) => reports.push(error)
  let cleanups = 0
  function observe(primaryFailure, failsCleanup) {
    reports.length = 0
    try {
      finishFixtureCleanup(
        primaryFailure,
        () => {
          cleanups++
          if (failsCleanup) throw cleanup
        },
        'fixture cleanup probe',
        report,
      )
    } catch (error) {
      return error
    }
    return undefined
  }
  assert.equal(observe(primary, false), primary)
  assert.deepEqual(reports, [primary])
  assert.equal(observe(undefined, true), cleanup)
  assert.deepEqual(reports, [cleanup])
  const both = observe(primary, true)
  assert.ok(both instanceof AggregateError)
  assert.equal(both.errors[0], primary)
  assert.equal(both.errors[1], cleanup)
  assert.equal(both.cause, primary)
  assert.deepEqual(reports, [primary, cleanup])
  assert.equal(observe(undefined, false), undefined)
  assert.deepEqual(reports, [])
  assert.equal(cleanups, 4, 'Cleanup must execute after primary failures and success')
  const scratchCleanup = new Error('Owned scratch cleanup fixture probe')
  let nested
  try {
    finishFixtureCleanup(
      both,
      () => {
        throw scratchCleanup
      },
      'nested cleanup probe',
      report,
    )
  } catch (error) {
    nested = error
  }
  assert.ok(nested instanceof AggregateError)
  assert.equal(nested.errors[0], both)
  assert.equal(nested.errors[1], scratchCleanup)
  const fullDiagnostics = []
  reportFixtureFailure(nested, 'nested diagnostic probe', (line) => fullDiagnostics.push(line))
  for (const error of [primary, cleanup, scratchCleanup]) {
    assert.ok(
      fullDiagnostics.join('\n').includes(error.stack),
      'Nested failure diagnostics must include every original full stack',
    )
  }
  let earlyFailure
  try {
    ;(() => {
      try {
        return 'early return'
      } finally {
        finishFixtureCleanup(
          undefined,
          () => {
            throw cleanup
          },
          'early return cleanup probe',
          report,
        )
      }
    })()
  } catch (error) {
    earlyFailure = error
  }
  assert.equal(earlyFailure, cleanup, 'A cleanup failure must override a successful early return')
  console.log(
    'Fixture cleanup probe passed: primary and cleanup identities retained separately, ordered AggregateError preserved, and early return cannot hide a cleanup failure.',
  )
}

async function bounded(promise, timeoutMs, message) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function maybeRead(filename, encoding) {
  try {
    return fs.readFileSync(filename, encoding)
  } catch (error) {
    if (['ENOENT', 'EACCES', 'EPERM', 'EBUSY'].includes(error.code)) return undefined
    throw error
  }
}

function phases(text) {
  return (text ?? '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split('\t')[0])
}

async function waitFixtureFile(filename, timeoutMs, description, completion) {
  const deadline = performance.now() + timeoutMs
  let ended
  completion?.then((result) => {
    ended = result
  })
  while (performance.now() < deadline) {
    const content = maybeRead(filename, 'utf8')
    if (content !== undefined) return content
    if (ended)
      throw new Error(`${description}: observer exited before evidence (${JSON.stringify(ended)})`)
    await immediate()
  }
  throw new Error(`${description}: evidence deadline expired`)
}

function fixtureChild(executable, args, env) {
  const child = spawn(executable, args, {
    cwd: path.dirname(executable),
    env,
    windowsHide: true,
    shell: false,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '',
    stderr = '',
    spawnError
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8')
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8')
  })
  child.once('error', (error) => {
    spawnError = error
  })
  const completion = new Promise((resolve) =>
    child.once('close', (code, signal) =>
      resolve({ code, signal, error: spawnError?.message, stdout, stderr }),
    ),
  )
  return { child, completion }
}

async function startDecoderObserver({ scratch, name, source, config, env }) {
  const configFile = path.join(path.dirname(config.ReadyFile), `${name}.observer-config.json`)
  fs.writeFileSync(configFile, JSON.stringify(config))
  const observer = fixtureChild(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      source,
      '-ConfigPath',
      configFile,
    ],
    windowsPowerShellEnvironment(env),
  )
  assert.equal(
    await waitFixtureFile(
      config.ReadyFile,
      30000,
      `${name} native observer startup`,
      observer.completion,
    ),
    'ready\r\n',
  )
  return {
    ...observer,
    config,
    async observed() {
      return JSON.parse(
        await waitFixtureFile(
          config.ObservedFile,
          30000,
          `${name} pinned process identities`,
          observer.completion,
        ),
      )
    },
    async result() {
      const exit = await bounded(
        observer.completion,
        35000,
        `${name} native observer did not terminate`,
      )
      const diagnostic = maybeRead(config.ResultFile, 'utf8')
      console.log(`${name} native lifetime evidence: ${diagnostic || JSON.stringify(exit)}`)
      assert.equal(
        exit.code,
        0,
        `${name}: native observer failed\n${exit.stdout}\n${exit.stderr}\n${diagnostic}`,
      )
      const result = JSON.parse(diagnostic)
      assert.equal(result.Success, true)
      assert.deepEqual(result.CleanupFailures, [])
      return result
    },
  }
}

// Caller builds a separate good Copy-method archive and compiles the actual
// normal wrapper against its manifest. It writes its own process ID into
// `${report}.pid` immediately before calling extractUsing7za.
async function interruptActualExtraction({
  executable,
  env,
  target,
  report,
  trace,
  expectedSize,
  expectedPrefix,
  expectedTail,
  expectedSha256,
  filename = 'large.bin',
  observer,
}) {
  assert.equal(process.platform, 'win32')
  assert.ok(expectedPrefix.length > 0 && expectedTail.length > 0)
  assert.ok(expectedSize > expectedPrefix.length + expectedTail.length)
  assert.ok(expectedPrefix.some((byte) => byte !== 0))
  assert.ok(expectedTail.some((byte) => byte !== 0))
  for (const item of [
    trace,
    report,
    `${report}.pid`,
    `${report}.registered`,
    `${report}.launched`,
  ]) {
    assert.equal(
      fs.existsSync(item),
      false,
      `Interruption trial must use fresh evidence files: ${item}`,
    )
  }
  assert.deepEqual(fs.readdirSync(target), [], 'Interrupted direct extraction must start empty')
  const output = path.join(target, filename)
  const child = spawn(executable, ['/S'], {
    cwd: path.dirname(executable),
    env,
    windowsHide: true,
    shell: false,
    detached: false,
    stdio: 'ignore',
  })
  let exited = false
  let spawnError
  child.once('error', (error) => {
    spawnError = error
  })
  const completion = new Promise((resolve) => {
    child.once('close', (code, signal) => {
      exited = true
      resolve({ code, signal, error: spawnError })
    })
  })
  let fd
  let started = false
  let pidConfirmed = false
  let observed
  let pinned, pinFailure
  let interruptionFailure
  const pinning = observer?.observed().then(
    (value) => {
      pinned = value
    },
    (error) => {
      pinFailure = error
    },
  )
  const prefix = Buffer.alloc(expectedPrefix.length)
  const tail = Buffer.alloc(expectedTail.length)
  try {
    await bounded(
      new Promise((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
      }),
      10000,
      'Native fixture did not launch',
    )
    const deadline = performance.now() + 30000
    while (performance.now() < deadline) {
      if (pinFailure) throw pinFailure
      if (exited)
        throw new Error('Native extraction completed before an incomplete write was observed')
      if (!pidConfirmed) {
        const nativePid = maybeRead(`${report}.pid`, 'ascii')
        if (nativePid !== undefined && /^\d+\r?\n$/.test(nativePid)) {
          assert.equal(
            Number(nativePid.trim()),
            child.pid,
            'Kill handle must identify the actual extractor process',
          )
          pidConfirmed = true
        }
      }
      if (!started) {
        const logged = phases(maybeRead(trace, 'ascii'))
        if (logged.includes('extract-complete')) {
          throw new Error('Extractor returned before incomplete content was observed')
        }
        started =
          logged.includes('payload-direct-start') &&
          logged.includes('extract-start') &&
          (!observer || logged.includes('modern-decoder-start'))
      }
      if (started && pidConfirmed) {
        if (fd === undefined) {
          try {
            // libuv uses FILE_SHARE_READ|WRITE|DELETE; this is compatible with
            // Nsis7z's GENERIC_WRITE + FILE_SHARE_READ output handle.
            fd = fs.openSync(output, 'r')
          } catch (error) {
            if (!['ENOENT', 'EACCES', 'EPERM', 'EBUSY'].includes(error.code)) throw error
          }
        }
        if (fd !== undefined) {
          const prefixRead = fs.readSync(fd, prefix, 0, prefix.length, 0)
          const tailRead = fs.readSync(fd, tail, 0, tail.length, expectedSize - tail.length)
          const currentSize = fs.fstatSync(fd).size
          const growing = observer && currentSize >= prefix.length && currentSize < expectedSize
          if (
            prefixRead === prefix.length &&
            prefix.equals(expectedPrefix) &&
            (growing || (tailRead === tail.length && tail.every((byte) => byte === 0))) &&
            (!observer || pinned)
          ) {
            observed = {
              pid: child.pid,
              size: currentSize,
              elapsedMs: 30000 - (deadline - performance.now()),
            }
            if (observer) {
              assert.equal(pinned.parentPid, child.pid, 'Observer must pin the actual NSIS owner')
              fs.writeFileSync(
                observer.config.KillRequestFile + '.pending',
                observer.config.RequestToken + '\r\n',
                { flag: 'wx' },
              )
              fs.renameSync(
                observer.config.KillRequestFile + '.pending',
                observer.config.KillRequestFile,
              )
            } else
              assert.equal(
                child.kill('SIGKILL'),
                true,
                'Native extractor must receive the termination request',
              )
            break
          }
        }
      }
      // Yield without the Windows timer quantum so a fast actual writer cannot
      // finish between startup polling intervals. No installer delay is added.
      await immediate()
    }
    assert.ok(observed, 'No actual incomplete extraction was observed before the deadline')
    let lifetime
    if (observer) {
      await pinning
      lifetime = await observer.result()
      assert.equal(lifetime.ParentPid, child.pid)
      assert.equal(lifetime.DecoderPid, pinned.decoderPid)
      assert.equal(lifetime.ParentWait, 0)
      assert.equal(lifetime.DecoderWait, 0)
      assert.equal(lifetime.ParentKilled, true)
      assert.equal(
        fs.existsSync(path.join(target, '.life-installer-extractor-guard')),
        false,
        'After both exact exits, the owned guard must be absent before any verifier, recovery or cleanup',
      )
    }
    const exit = await bounded(completion, 10000, 'Killed native extractor did not exit')
    if (exit.error) throw exit.error
    assert.ok(exit.code !== 0 || exit.signal, 'Interrupted fixture cannot report successful exit')
    // Close our read handle before retrying the unchanged normal wrapper.
    fs.closeSync(fd)
    fd = undefined
    const after = fs.readFileSync(output)
    if (!observer)
      assert.equal(
        after.length,
        expectedSize,
        'Preallocated file length must survive the interruption',
      )
    else
      assert.ok(
        after.length >= expectedPrefix.length && after.length <= expectedSize,
        'Modern extraction must retain its actual incomplete written bytes',
      )
    assert.ok(
      after.subarray(0, expectedPrefix.length).equals(expectedPrefix),
      'Written prefix must survive interruption',
    )
    if (!observer || after.length === expectedSize)
      assert.ok(
        after.subarray(expectedSize - expectedTail.length).every((byte) => byte === 0),
        'Post-exit tail must remain unwritten; a kill that lost its race is not interruption evidence',
      )
    assert.notEqual(
      createHash('sha256').update(after).digest('hex'),
      expectedSha256,
      'Interrupted file must fail the trusted full manifest hash',
    )
    const logged = phases(fs.readFileSync(trace, 'ascii'))
    assert.deepEqual(
      logged,
      ['payload-direct-start', 'extract-start', ...(observer ? ['modern-decoder-start'] : [])],
      'Interrupted extraction cannot reach verification, completion, registration or launch',
    )
    for (const item of [report, `${report}.registered`, `${report}.launched`]) {
      assert.equal(
        fs.existsSync(item),
        false,
        'Interrupted extraction cannot produce successful action sentinels',
      )
    }
    if (observer) {
      const stable = inventory(target)
      assert.deepEqual(
        inventory(target),
        stable,
        'After both exact process waits, the complete output inventory and all hashes must remain stable',
      )
      assert.equal(fs.statSync(output).size, after.length)
      assert.equal(sha256(output), createHash('sha256').update(after).digest('hex'))
    }
    return { ...observed, exit, lifetime, finalSize: after.length, phases: logged }
  } catch (error) {
    interruptionFailure = error
  } finally {
    const cleanupErrors = []
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (!exited) {
      child.kill('SIGKILL')
      try {
        await bounded(completion, 10000, 'Failed interrupted trial left a live fixture process')
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (observer) {
      try {
        const exit = await bounded(
          observer.completion,
          35000,
          'Native observer did not release its pinned process handles before cleanup',
        )
        if (exit.code !== 0) {
          const diagnostic = maybeRead(observer.config.ResultFile, 'utf8') || JSON.stringify(exit)
          console.error(`Native observer failure retained before cleanup: ${diagnostic}`)
          cleanupErrors.push(new Error(`Native observer cleanup failed: ${diagnostic}`))
        }
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    finishFixtureCleanup(
      interruptionFailure,
      () => {
        if (cleanupErrors.length)
          throw new AggregateError(cleanupErrors, 'Native interruption cleanup failed')
      },
      'interrupted extractor and observer',
    )
  }
}

function nsisString(value) {
  return String(value)
    .replaceAll('$', () => '$$')
    .replaceAll('"', '$\\"')
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
    ...options,
  })
  if (result.error) throw result.error
  return result
}

function requireSuccess(command, args, options) {
  const result = run(command, args, options)
  assert.equal(result.status, 0, `${command} failed:\n${result.stdout}\n${result.stderr}`)
  return result
}

function windowsPowerShellEnvironment(environment) {
  // pwsh -> Node -> Windows PowerShell otherwise inherits incompatible PS7
  // module paths. Let this child reconstruct its native defaults at startup.
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH'),
  )
}

function sha256(filename) {
  return createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
}

function inventory(directory) {
  const entries = []
  function visit(current, relative) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name
      const filename = path.join(current, entry.name)
      assert.equal(entry.isSymbolicLink(), false, `Unexpected linked fixture entry: ${name}`)
      if (entry.isDirectory()) {
        entries.push({ name, directory: true })
        visit(filename, name)
      } else {
        assert.ok(entry.isFile(), `Unexpected nonregular fixture entry: ${name}`)
        entries.push({ name, directory: false, sha256: sha256(filename) })
      }
    }
  }
  visit(directory, '')
  return entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))
}

async function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'life-nsis-payload-fixture-'))
  let primaryFailure
  try {
    verifyFixtureCleanup()
    const [sevenZip, binary, plugins] = await Promise.all([
      getPath7za(),
      getMakeNsisPath(),
      getNsisPluginsPath(),
    ])
    let modern
    if (process.platform === 'win32') {
      const {
        prepareWindowsDecoderBundle,
        binaryName,
        pins,
      } = require('./package-windows-decoder.cjs')
      const decoderDirectory = await prepareWindowsDecoderBundle({
        root,
        output: path.join(scratch, 'official-modern-decoder'),
      })
      const decoder = path.join(decoderDirectory, binaryName)
      assert.equal(
        sha256(decoder),
        pins.binary.sha256,
        'Native fixture requires the exact official decoder',
      )
      assert.equal(
        pins.binary.sha256,
        '15d4c788c148e3677e2fc1c4a01f191fb6669eba4f6acf8a465f0f1a6f1e1260',
      )
      const pluginDirectory = path.join(scratch, 'production-launcher')
      const fixturePluginDirectory = path.join(scratch, 'fixture-launcher')
      for (const [outputDirectory, fixture] of [
        [pluginDirectory, false],
        [fixturePluginDirectory, true],
      ]) {
        requireSuccess(process.execPath, [
          path.join(root, 'scripts', 'build-modern-extractor.cjs'),
          '--output-directory',
          outputDirectory,
          ...(fixture ? ['--fixture'] : []),
        ])
        assert.ok(fs.statSync(path.join(outputDirectory, 'LifeInstallerLauncher.dll')).isFile())
      }
      modern = { decoder, pluginDirectory, fixturePluginDirectory }
      modern.observerSource = path.join(scratch, 'life-modern-decoder-observer.ps1')
      modern.fakeSource = path.join(scratch, 'life-fake-decoder.cs')
      modern.fakeCompileSource = path.join(scratch, 'life-fake-decoder-compile.ps1')
      modern.fakeObserverSource = path.join(scratch, 'life-fake-decoder-observer.ps1')
      modern.fakeExecutable = path.join(scratch, 'life-fake-decoder.exe')
      modern.mutationNativeSource = path.join(scratch, 'life-directory-mutation.cs')
      modern.mutationSource = path.join(scratch, 'life-directory-mutation.ps1')
      fs.writeFileSync(path.join(scratch, 'life-modern-decoder-observer.cs'), decoderObserverNative)
      fs.writeFileSync(modern.observerSource, '\ufeff' + decoderObserverScript)
      fs.writeFileSync(modern.fakeSource, fakeDecoderNative)
      fs.writeFileSync(modern.fakeCompileSource, '\ufeff' + fakeDecoderCompileScript)
      fs.writeFileSync(modern.fakeObserverSource, '\ufeff' + fakeDecoderObserverScript)
      fs.writeFileSync(modern.mutationNativeSource, directoryMutationNative)
      fs.writeFileSync(modern.mutationSource, '\ufeff' + directoryMutationScript)
      requireSuccess(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          modern.fakeCompileSource,
          '-OwnedRoot',
          scratch,
          '-Source',
          modern.fakeSource,
          '-Output',
          modern.fakeExecutable,
        ],
        {
          env: windowsPowerShellEnvironment(process.env),
        },
      )
    }
    const payload = path.join(scratch, 'trusted-payload')
    fs.mkdirSync(path.join(payload, 'nested', '研究$'), { recursive: true })
    fs.mkdirSync(path.join(payload, 'empty'))
    const bytes = Buffer.alloc(65571)
    let state = 0x6c696665
    for (let i = 0; i < bytes.length; i++) {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      bytes[i] = state & 0xff
    }
    fs.writeFileSync(path.join(payload, 'payload.bin'), bytes)
    fs.writeFileSync(
      path.join(payload, 'nested', '研究$', "entry-$value-'quote-`tick.txt"),
      'Life payload fixture\n',
    )
    const fixedTime = new Date('2020-01-02T03:04:05Z')
    function fixPayloadTimes(directory) {
      for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        const filename = path.join(directory, item.name)
        if (item.isDirectory()) fixPayloadTimes(filename)
        fs.utimesSync(filename, fixedTime, fixedTime)
      }
    }
    fixPayloadTimes(payload)

    function archive(source, name) {
      const filename = path.join(scratch, name)
      requireSuccess(
        sevenZip,
        ['a', '-t7z', '-m0=Copy', '-ms=off', '-mhc=off', '-y', filename, '.'],
        { cwd: source },
      )
      requireSuccess(sevenZip, ['t', filename])
      return filename
    }

    const good = archive(payload, 'good.7z')
    const goodBytes = fs.readFileSync(good)
    const payloadOffset = goodBytes.indexOf(bytes)
    assert.ok(
      payloadOffset >= 32,
      'The Copy-method archive must contain the complete fixture bytes',
    )
    assert.equal(goodBytes.indexOf(bytes, payloadOffset + 1), -1, 'Fixture bytes must occur once')
    const corrupt = path.join(scratch, 'crc-corrupt.7z')
    const corruptBytes = Buffer.from(goodBytes)
    corruptBytes[payloadOffset + Math.floor(bytes.length / 2)] ^= 0x80
    fs.writeFileSync(corrupt, corruptBytes)
    const corruptOutput = path.join(scratch, 'crc-output')
    const corruptResult = run(sevenZip, ['x', '-y', `-o${corruptOutput}`, corrupt])
    assert.equal(
      corruptResult.status,
      2,
      'The negative archive must have an actual payload CRC error',
    )
    assert.equal(fs.statSync(path.join(corruptOutput, 'payload.bin')).size, bytes.length)
    assert.notEqual(
      sha256(path.join(corruptOutput, 'payload.bin')),
      sha256(path.join(payload, 'payload.bin')),
    )

    const truncated = path.join(scratch, 'truncated.7z')
    fs.writeFileSync(truncated, goodBytes.subarray(0, 24))
    assert.notEqual(run(sevenZip, ['t', truncated]).status, 0, 'Truncated header must be invalid')
    const shortPayload = path.join(scratch, 'short-payload')
    fs.cpSync(payload, shortPayload, { recursive: true })
    fs.writeFileSync(path.join(shortPayload, 'payload.bin'), bytes.subarray(0, bytes.length - 1))
    const short = archive(shortPayload, 'short-valid-crc.7z')
    const collisionPayload = path.join(scratch, 'guard-collision-payload')
    fs.cpSync(payload, collisionPayload, { recursive: true })
    const collisionText = 'Legitimate trusted file using the installer guard name\n'
    fs.writeFileSync(path.join(collisionPayload, '.life-installer-extractor-guard'), collisionText)
    fixPayloadTimes(collisionPayload)
    const collisionArchive = archive(collisionPayload, 'guard-collision-good.7z')

    for (const [name, filename] of [
      ['crc', corrupt],
      ['truncated', truncated],
    ]) {
      const output = path.join(scratch, `${name}-must-not-generate.nsh`)
      const result = run(process.execPath, [
        path.join(root, 'scripts', 'generate-installer-payload.cjs'),
        '--archive',
        filename,
        '--arch',
        '64',
        '--output',
        output,
      ])
      assert.notEqual(result.status, 0, `The manifest generator must reject ${name} corruption`)
      assert.equal(
        fs.existsSync(output),
        false,
        'Invalid archives must not produce trusted manifests',
      )
    }

    const includes = path.join(
      path.dirname(require.resolve('app-builder-lib/package.json')),
      'templates',
      'nsis',
      'include',
    )
    const source = path.join(scratch, 'fixture.nsi')
    const executable = path.join(scratch, 'fixture.exe')
    const registers = Array.from({ length: 10 }, (_, index) => [`$${index}`, `$R${index}`]).flat()
    const initialize = registers
      .map((register, i) => `StrCpy ${register} "register-${i}"`)
      .join('\n')
    const check = registers
      .map(
        (register, i) =>
          `StrCpy $fixtureStage "register-${i}"\nStrCmp ${register} "register-${i}" 0 fixture_failed`,
      )
      .join('\n')
    const reportRegisters = registers
      .map(
        (register, i) =>
          String.raw`FileWriteUTF16LE $fixtureHandle "register-${i} (${nsisString(register)})=${register}$\r$\n"`,
      )
      .join('\n')
    fs.writeFileSync(
      source,
      '\ufeff' +
        String.raw`Unicode true
Name "Life installer payload fixture"
OutFile "${nsisString(executable)}"
RequestExecutionLevel user
SilentInstall silent
!define PROJECT_DIR "${nsisString(root)}"
!define APP_64 "${nsisString(good)}"
!define PRODUCT_NAME "Life fixture"
!define LIFE_NSIS_MODERN_FIXTURE
${modern ? `!define LIFE_MODERN_ENABLED\n!define LIFE_MODERN_DECODER_EXE "${nsisString(modern.decoder)}"\n!define LIFE_MODERN_PLUGIN_DIR "${nsisString(modern.pluginDirectory)}"` : ''}
!addincludedir "${nsisString(includes)}"
!addincludedir "${nsisString(path.join(root, 'build'))}"
!addplugindir /x86-unicode "${nsisString(path.join(plugins, 'x86-unicode'))}"
!include "LogicLib.nsh"
!include "StdUtils.nsh"
LoadLanguageFile "${'${NSISDIR}'}\Contrib\Language files\English.nlf"
LangString appCannotBeClosed 1033 "The fixture payload is locked."
!include "${nsisString(path.join(root, 'build', 'installer.nsh'))}"
!insertmacro customHeader
!include "${nsisString(path.join(root, 'build', 'installer-extract-profile.nsh'))}"
Var packageArch
Var fixtureMode
Var fixtureExpected
Var fixtureResult
Var fixtureScratch
Var fixtureReport
Var fixtureArchive
Var fixtureHandle
Var fixtureHandleCount
Var fixtureLock
Var fixtureHashCount
Var fixtureHashKind
Var fixtureHashLockBuffer
Var fixtureStage
Var fixtureErrorAtEntry
Var fixtureErrorAtExit
Var fixtureErrorAtFailure
Var fixtureStackTop
Var fixtureStackBottom
Var fixturePendingTop
Var fixturePendingBottom
Var fixtureCurrentHandleCount
Var fixtureDecoder
Var fixtureOutput
Var fixtureWarmOutput
Var fixtureLaunchMarker
Var fixtureLaunchMode
Var fixtureDescendantPidFile
Var fixtureNativeStatus
Var fixtureNativeWait
!ifdef LIFE_MODERN_ENABLED
Var fixtureDescendantPid
Var fixtureDescendantHandle
Var fixtureBoundaryError
!endif

!macro FixtureObserveError OUTPUT
  StrCpy ${'${OUTPUT}'} "0"
  IfErrors 0 +3
  StrCpy ${'${OUTPUT}'} "1"
  SetErrors
!macroend

!macro FixturePublishPid TAG
  ; Optional ReadEnvStr calls can leave a sticky error before this publisher.
  ; Establish this operation's state before creating the owned ASCII record.
  ClearErrors
  StrCpy $fixtureStage "pid-query"
  System::Call 'kernel32::GetCurrentProcessId() i.s ?r'
  Pop $fixtureNativeStatus
  Pop $fixtureScratch
  StrCmp $fixtureNativeStatus "ok" 0 fixture_failed
  StrCmp $fixtureScratch 0 fixture_failed
  StrCpy $fixtureStage "pid-open"
  FileOpen $fixtureHandle "$fixtureReport.pid" w
  IfErrors fixture_failed
  StrCpy $fixtureStage "pid-write"
  FileWrite $fixtureHandle "$fixtureScratch$\r$\n"
  IfErrors fixture_pid_failed_${'${TAG}'}
  StrCpy $fixtureStage "pid-flush"
  System::Call 'kernel32::FlushFileBuffers(p $fixtureHandle) i.s ?r'
  Pop $fixtureNativeStatus
  Pop $fixtureNativeWait
  StrCmp $fixtureNativeStatus "ok" 0 fixture_pid_failed_${'${TAG}'}
  StrCmp $fixtureNativeWait 0 fixture_pid_failed_${'${TAG}'}
  StrCpy $fixtureStage "pid-close"
  System::Call 'kernel32::CloseHandle(p $fixtureHandle) i.s ?r'
  Pop $fixtureNativeStatus
  Pop $fixtureNativeWait
  StrCmp $fixtureNativeStatus "ok" 0 fixture_failed
  StrCmp $fixtureNativeWait 0 fixture_failed
  Goto fixture_pid_complete_${'${TAG}'}
  fixture_pid_failed_${'${TAG}'}:
    ; Retain the original write/flush stage and check this handle's cleanup.
    System::Call 'kernel32::CloseHandle(p $fixtureHandle) i.s ?r'
    Pop $fixtureNativeStatus
    Pop $fixtureNativeWait
    StrCmp $fixtureNativeStatus "ok" 0 fixture_failed
    StrCmp $fixtureNativeWait 0 fixture_failed
    Goto fixture_failed
  fixture_pid_complete_${'${TAG}'}:
    StrCpy $fixtureHandle ""
    ClearErrors
!macroend

!macro FixtureBegin
  !insertmacro FixtureObserveError $fixtureErrorAtEntry
  StrCpy $fixtureStage "call"
  StrCpy $fixtureErrorAtExit "unobserved"
  StrCpy $fixtureStackTop "unobserved"
  StrCpy $fixtureStackBottom "unobserved"
  ${initialize}
  Push "stack-bottom"
  Push "stack-top"
!macroend

!macro FixtureCheck
  !insertmacro FixtureObserveError $fixtureErrorAtExit
  StrCpy $fixtureStage "result"
  StrCmpS $fixtureResult $fixtureExpected 0 fixture_failed
  StrCpy $fixtureStage "stack-top"
  Pop $fixtureScratch
  StrCpy $fixtureStackTop $fixtureScratch
  StrCmp $fixtureScratch "stack-top" 0 fixture_failed
  StrCpy $fixtureStage "stack-bottom"
  Pop $fixtureScratch
  StrCpy $fixtureStackBottom $fixtureScratch
  StrCmp $fixtureScratch "stack-bottom" 0 fixture_failed
  ${check}
!macroend

!macro FixtureGuard
  !insertmacro FixtureBegin
  Push "$INSTDIR"
  Call LifeEmptyPayloadDirectory
  Pop $fixtureResult
  !insertmacro FixtureCheck
!macroend

!macro FixtureRequired
  !insertmacro FixtureBegin
  !insertmacro LifeVerifyPayload64 "$INSTDIR" $fixtureResult
  !insertmacro FixtureCheck
!macroend

!macro FixtureExact
  !insertmacro FixtureBegin
  !insertmacro LifeVerifyStagedPayload64 "$INSTDIR" $fixtureResult
  !insertmacro FixtureCheck
!macroend

!macro FixturePreflight
  !insertmacro FixtureBegin
  !insertmacro LifePreflightPayload64 "$INSTDIR" $fixtureResult
  !insertmacro FixtureCheck
!macroend

!macro FixtureHash HASHER
  !insertmacro FixtureBegin
  !insertmacro ${'${HASHER}'} "$INSTDIR" $fixtureResult
  !insertmacro FixtureCheck
!macroend

!macro FixtureStockHash
  !insertmacro FixtureBegin
  Push "SHA2-256"
  Push "$INSTDIR"
  StdUtils::HashFile /NOUNLOAD
  Pop $fixtureResult
  ; StdUtils may format hexadecimal in uppercase. Compare that established
  ; digest case-insensitively; raw/public CNG results remain exact lowercase.
  StrCmp $fixtureResult $fixtureExpected 0 fixture_failed
  StrCpy $fixtureResult $fixtureExpected
  !insertmacro FixtureCheck
!macroend

!ifdef LIFE_MODERN_ENABLED
!macro FixtureLaunch
  !insertmacro FixtureBegin
  Push "$fixtureOutput"
  Push "$fixtureArchive"
  Push "$fixtureDecoder"
  LifeInstallerLauncher::Launch /NOUNLOAD
  Pop $fixtureResult
  ${'${If}'} $fixtureDescendantPidFile != ""
  !insertmacro FixtureObserveError $fixtureBoundaryError
  FileOpen $fixtureHandle "$fixtureDescendantPidFile" r
  IfErrors fixture_failed
  FileRead $fixtureHandle $fixtureDescendantPid
  FileClose $fixtureHandle
  ClearErrors
  StrCmp $fixtureDescendantPid "" fixture_failed
  StrCpy $fixtureStage "descendant-open-after-launch"
  System::Call 'kernel32::OpenProcess(i 0x00100000, i 0, i $fixtureDescendantPid) p.s ?r'
  Pop $fixtureNativeStatus
  Pop $fixtureDescendantHandle
  StrCmp $fixtureNativeStatus "ok" 0 fixture_failed
  StrCmp $fixtureDescendantHandle 0 fixture_failed
  StrCpy $fixtureStage "descendant-signaled-at-launch-return"
  System::Call 'kernel32::WaitForSingleObject(p $fixtureDescendantHandle, i 0) i.s ?r'
  Pop $fixtureNativeStatus
  Pop $fixtureNativeWait
  StrCmp $fixtureNativeStatus "ok" 0 fixture_failed
  StrCmp $fixtureNativeWait 0 0 fixture_failed
  System::Call 'kernel32::CloseHandle(p $fixtureDescendantHandle) i.s ?r'
  Pop $fixtureNativeStatus
  Pop $fixtureNativeWait
  StrCmp $fixtureNativeStatus "ok" 0 fixture_failed
  StrCmp $fixtureNativeWait 0 fixture_failed
  ${'${If}'} $fixtureBoundaryError == "1"
    SetErrors
  ${'${Else}'}
    ClearErrors
  ${'${EndIf}'}
  ${'${EndIf}'}
  !insertmacro FixtureCheck
!macroend
!endif

Section
  InitPluginsDir
  ; The process helper has its own native fixture; retain its definition under
  ; warnings-as-errors without running unrelated process queries in this proof.
  GetFunctionAddress $fixtureScratch LifeNoScopedProcess
  ReadEnvStr $fixtureMode "LIFE_NSIS_PAYLOAD_FIXTURE_MODE"
  ReadEnvStr $INSTDIR "LIFE_NSIS_PAYLOAD_FIXTURE_TARGET"
  ReadEnvStr $fixtureExpected "LIFE_NSIS_PAYLOAD_FIXTURE_EXPECTED"
  ReadEnvStr $fixtureReport "LIFE_NSIS_PAYLOAD_FIXTURE_RESULT"
  ReadEnvStr $fixtureArchive "LIFE_NSIS_PAYLOAD_FIXTURE_ARCHIVE"
  ReadEnvStr $fixtureDecoder "LIFE_NSIS_PAYLOAD_FIXTURE_DECODER"
  ReadEnvStr $fixtureOutput "LIFE_NSIS_PAYLOAD_FIXTURE_OUTPUT"
  ReadEnvStr $fixtureWarmOutput "LIFE_NSIS_PAYLOAD_FIXTURE_WARM_OUTPUT"
  ReadEnvStr $fixtureLaunchMarker "LIFE_NSIS_PAYLOAD_FIXTURE_LAUNCH_MARKER"
  ReadEnvStr $fixtureLaunchMode "LIFE_NSIS_PAYLOAD_FIXTURE_LAUNCH_MODE"
  ReadEnvStr $fixtureDescendantPidFile "LIFE_NSIS_PAYLOAD_FIXTURE_DESCENDANT_PID_FILE"
  StrCpy $packageArch "64"
  ; Warm persistent plug-in loads before checking for enumeration/hash handle leaks.
  ${'${GetProcessInfo}'} 0 $pid $1 $2 $3 $4
  ${'${StdUtils.HashFile}'} $fixtureScratch "SHA2-256" "$fixtureArchive"
  !insertmacro LifeNativeHashFile "$fixtureArchive" $fixtureScratch
  !insertmacro LifeHashFile "$fixtureArchive" $fixtureScratch
  !ifdef LIFE_MODERN_ENABLED
    StrCmp $fixtureMode "launch" fixture_warm_launch
    StrCmp $fixtureMode "launch-once" fixture_warm_launch
    StrCmp $fixtureMode "launch-locked" fixture_warm_launch fixture_warm_complete
    fixture_warm_launch:
      StrCpy $fixtureStage "warm-launch-expected-ok"
      !insertmacro FixtureObserveError $fixtureErrorAtEntry
      Push "$fixtureWarmOutput"
      Push "${nsisString(good)}"
      Push "${nsisString(modern?.decoder || '')}"
      LifeInstallerLauncher::Launch /NOUNLOAD
      Pop $fixtureScratch
      StrCpy $fixtureResult $fixtureScratch
      !insertmacro FixtureObserveError $fixtureErrorAtExit
      StrCmp $fixtureScratch "ok" 0 fixture_failed
    fixture_warm_complete:
  !endif
  System::Call 'kernel32::GetCurrentProcess() p .r0'
  System::Call 'kernel32::GetProcessHandleCount(p r0, *i .r1) i .r2'
  StrCmp $2 "0" fixture_failed
  StrCpy $fixtureHandleCount $1

  StrCmp $fixtureMode "guard" fixture_guard
  StrCmp $fixtureMode "required" fixture_required
  StrCmp $fixtureMode "exact" fixture_exact
  StrCmp $fixtureMode "preflight" fixture_preflight
  StrCmp $fixtureMode "hash-native" fixture_hash_native
  StrCmp $fixtureMode "hash-wrapper" fixture_hash_wrapper
  StrCmp $fixtureMode "hash-stock" fixture_hash_stock
  StrCmp $fixtureMode "hash-native-locked" fixture_hash_native_locked
  StrCmp $fixtureMode "hash-wrapper-locked" fixture_hash_wrapper_locked
  !ifdef LIFE_MODERN_ENABLED
    StrCmp $fixtureMode "launch" fixture_launch
    StrCmp $fixtureMode "launch-once" fixture_launch_once
    StrCmp $fixtureMode "launch-locked" fixture_launch_locked
    !ifdef LIFE_LAUNCHER_NATIVE_FIXTURE
      StrCmp $fixtureMode "launch-fixture" fixture_launch_fault
    !endif
  !endif
  StrCmp $fixtureMode "extract" fixture_extract
  !ifdef LIFE_MODERN_ENABLED
    StrCmp $fixtureMode "extract-wrong-pin" fixture_extract_wrong_pin
  !endif
  StrCmp $fixtureMode "extract-locked" fixture_extract_locked fixture_failed

  fixture_guard:
    ClearErrors
    !insertmacro FixtureGuard
    IfErrors fixture_failed
    SetErrors
    !insertmacro FixtureGuard
    IfErrors +2 0
    Goto fixture_failed
    Goto fixture_check_handles

  !ifdef LIFE_MODERN_ENABLED
    fixture_launch_once:
      ClearErrors
      !insertmacro FixtureLaunch
      StrCpy $fixtureStage "error-clear"
      IfErrors fixture_failed
      Goto fixture_check_handles
    !ifdef LIFE_LAUNCHER_NATIVE_FIXTURE
      fixture_launch_fault:
        !insertmacro FixturePublishPid fault
        !insertmacro FixtureBegin
        Push "$fixtureLaunchMode"
        Push "$fixtureLaunchMarker"
        Push "$fixtureOutput"
        Push "$fixtureArchive"
        Push "$fixtureDecoder"
        LifeInstallerLauncher::LaunchFixture /NOUNLOAD
        Pop $fixtureResult
        !insertmacro FixtureCheck
        Goto fixture_check_handles
    !endif
    fixture_launch_locked:
      System::Call 'kernel32::CreateFileW(w "$INSTDIR", i 0xC0000000, i 7, p 0, i 3, i 0, p 0) p .r0'
      StrCmp $0 "-1" fixture_failed
      StrCpy $fixtureLock $0
    fixture_launch:
      StrCpy $fixtureHashCount 8
    fixture_launch_repeat:
      ClearErrors
      !insertmacro FixtureLaunch
      StrCpy $fixtureStage "error-clear"
      IfErrors fixture_failed
      SetErrors
      !insertmacro FixtureLaunch
      StrCpy $fixtureStage "error-set"
      IfErrors +2 0
      Goto fixture_failed
      IntOp $fixtureHashCount $fixtureHashCount - 1
      StrCmp $fixtureHashCount 0 fixture_hash_complete fixture_launch_repeat
  !endif

  fixture_required:
    ClearErrors
    !insertmacro FixtureRequired
    IfErrors fixture_failed
    SetErrors
    !insertmacro FixtureRequired
    IfErrors +2 0
    Goto fixture_failed
    Goto fixture_check_handles

  fixture_exact:
    ClearErrors
    !insertmacro FixtureExact
    IfErrors fixture_failed
    SetErrors
    !insertmacro FixtureExact
    IfErrors +2 0
    Goto fixture_failed
    Goto fixture_check_handles

  fixture_preflight:
    ClearErrors
    !insertmacro FixturePreflight
    IfErrors fixture_failed
    SetErrors
    !insertmacro FixturePreflight
    IfErrors +2 0
    Goto fixture_failed
    Goto fixture_check_handles

  fixture_hash_native_locked:
    StrCpy $fixtureHashKind "native"
    Goto fixture_hash_lock
  fixture_hash_wrapper_locked:
    StrCpy $fixtureHashKind "wrapper"
  fixture_hash_lock:
    ; A caller-owned writer prevents the helper's readonly sharing contract.
    System::Call 'kernel32::CreateFileW(w "$INSTDIR", i 0xC0000000, i 7, p 0, i 3, i 0, p 0) p .r0'
    StrCmp $0 "-1" fixture_failed
    StrCpy $fixtureLock $0
    System::Call 'kernel32::CreateFileW(w "$INSTDIR", i 0x80000000, i 1, p 0, i 3, i 0x00200000, p 0) p .r0 ?re'
    Pop $1
    Pop $2
    StrCmp $2 "ok" 0 fixture_failed
    StrCmp $0 "-1" 0 fixture_failed
    StrCmp $1 "32" 0 fixture_failed
    StrCmp $fixtureHashKind "native" fixture_hash_native fixture_hash_wrapper

  fixture_hash_native:
    StrCpy $fixtureHashCount 8
  fixture_hash_native_repeat:
    ClearErrors
    !insertmacro FixtureHash LifeNativeHashFile
    StrCpy $fixtureStage "error-clear"
    IfErrors fixture_failed
    SetErrors
    !insertmacro FixtureHash LifeNativeHashFile
    StrCpy $fixtureStage "error-set"
    IfErrors +2 0
    Goto fixture_failed
    IntOp $fixtureHashCount $fixtureHashCount - 1
    StrCmp $fixtureHashCount 0 fixture_hash_complete fixture_hash_native_repeat

  fixture_hash_wrapper:
    StrCpy $fixtureHashCount 8
  fixture_hash_wrapper_repeat:
    ClearErrors
    !insertmacro FixtureHash LifeHashFile
    StrCpy $fixtureStage "error-clear"
    IfErrors fixture_failed
    SetErrors
    !insertmacro FixtureHash LifeHashFile
    StrCpy $fixtureStage "error-set"
    IfErrors +2 0
    Goto fixture_failed
    IntOp $fixtureHashCount $fixtureHashCount - 1
    StrCmp $fixtureHashCount 0 fixture_hash_complete fixture_hash_wrapper_repeat

  fixture_hash_stock:
    ClearErrors
    !insertmacro FixtureStockHash
    IfErrors fixture_failed
    SetErrors
    !insertmacro FixtureStockHash
    IfErrors +2 0
    Goto fixture_failed
    Goto fixture_hash_complete

  fixture_hash_complete:
    StrCmp $fixtureLock "" fixture_check_handles
    ; Re-read and write back the exact first byte through the caller's handle.
    ; Native hashing failures must leave that independent handle usable.
    System::Alloc 1
    Pop $fixtureHashLockBuffer
    StrCmp $fixtureHashLockBuffer 0 fixture_failed
    System::Call 'kernel32::ReadFile(p $fixtureLock, p $fixtureHashLockBuffer, i 1, *i .r1, p 0) i .r2'
    StrCmp $2 0 fixture_failed
    StrCmp $1 1 0 fixture_failed
    System::Call 'kernel32::SetFilePointer(p $fixtureLock, i 0, p 0, i 0) i .r0'
    StrCmp $0 0 0 fixture_failed
    System::Call 'kernel32::WriteFile(p $fixtureLock, p $fixtureHashLockBuffer, i 1, *i .r1, p 0) i .r2'
    StrCmp $2 0 fixture_failed
    StrCmp $1 1 0 fixture_failed
    System::Free $fixtureHashLockBuffer
    System::Call 'kernel32::CloseHandle(p $fixtureLock) i .r0'
    StrCmp $0 0 fixture_failed
    StrCpy $fixtureLock ""
    Goto fixture_check_handles

  fixture_extract_locked:
    System::Call 'kernel32::CreateFileW(w "$INSTDIR\payload.bin", i 0x80000000, i 0, p 0, i 3, i 0, p 0) p .r0'
    StrCmp $0 "-1" fixture_failed
    StrCpy $fixtureLock $0
    Goto fixture_extract
  !ifdef LIFE_MODERN_ENABLED
    fixture_extract_wrong_pin:
      CreateDirectory "$PLUGINSDIR\life-modern-decoder"
      IfErrors fixture_failed
      FileOpen $fixtureHandle "$PLUGINSDIR\life-modern-decoder\7za-26.04-x64.exe" w
      IfErrors fixture_failed
      FileWrite $fixtureHandle "Invalid fixture decoder pin$\r$\n"
      FileClose $fixtureHandle
  !endif
  fixture_extract:
    SetOutPath "$INSTDIR"
    !insertmacro FixturePublishPid extract
    !insertmacro extractUsing7za "$fixtureArchive"
    ; These represent registration and launch. Neither may run after a bad payload.
    FileOpen $fixtureHandle "$fixtureReport.registered" w
    IfErrors fixture_failed
    FileClose $fixtureHandle
    FileOpen $fixtureHandle "$fixtureReport.launched" w
    IfErrors fixture_failed
    FileClose $fixtureHandle
    Goto fixture_success

  fixture_check_handles:
    StrCpy $fixtureStage "handle-query"
    System::Call 'kernel32::GetCurrentProcess() p .r0'
    System::Call 'kernel32::GetProcessHandleCount(p r0, *i .r1) i .r2'
    StrCmp $2 "0" fixture_failed
    StrCpy $fixtureCurrentHandleCount $1
    StrCpy $fixtureStage "handle-count"
    StrCmp $1 $fixtureHandleCount 0 fixture_failed
  fixture_success:
    ClearErrors
    FileOpen $fixtureHandle "$fixtureReport" w
    IfErrors fixture_failed
    FileWrite $fixtureHandle "ok$\r$\n"
    FileClose $fixtureHandle
    SetErrorLevel 0
    Goto fixture_complete
  fixture_failed:
    !insertmacro FixtureObserveError $fixtureErrorAtFailure
    ; These pending pops are only failure diagnostics. All strict assertions
    ; above already failed, and the original error state was captured first.
    Pop $fixturePendingTop
    Pop $fixturePendingBottom
    ClearErrors
    FileOpen $fixtureHandle "$fixtureReport.diagnostic.txt" w
    IfErrors fixture_diagnostic_done
    FileWriteUTF16LE $fixtureHandle "mode=$fixtureMode$\r$\nstage=$fixtureStage$\r$\ntarget=$INSTDIR$\r$\nexpected=$fixtureExpected$\r$\nactual=$fixtureResult$\r$\nerror-entry=$fixtureErrorAtEntry$\r$\nerror-exit=$fixtureErrorAtExit$\r$\nerror-failure=$fixtureErrorAtFailure$\r$\nchecked-stack-top=$fixtureStackTop$\r$\nchecked-stack-bottom=$fixtureStackBottom$\r$\npending-stack-top=$fixturePendingTop$\r$\npending-stack-bottom=$fixturePendingBottom$\r$\nhandles-before=$fixtureHandleCount$\r$\nhandles-after=$fixtureCurrentHandleCount$\r$\n"
    ${reportRegisters}
    FileClose $fixtureHandle
  fixture_diagnostic_done:
    SetErrorLevel 7
    Quit
  fixture_complete:
SectionEnd
`,
    )
    requireSuccess(binary.path, ['-WX', '-V2', '-INPUTCHARSET', 'UTF8', source], {
      env: { ...process.env, ...binary.env },
    })
    const controlSource = path.join(scratch, 'stock-control.nsi')
    const controlExecutable = path.join(scratch, 'stock-control.exe')
    fs.writeFileSync(
      controlSource,
      '\ufeff' +
        String.raw`Unicode true
Name "Life stock installer payload control"
OutFile "${nsisString(controlExecutable)}"
RequestExecutionLevel user
SilentInstall silent
!define PRODUCT_NAME "Life stock fixture"
!addincludedir "${nsisString(includes)}"
!addplugindir /x86-unicode "${nsisString(path.join(plugins, 'x86-unicode'))}"
!include "LogicLib.nsh"
LoadLanguageFile "${'${NSISDIR}'}\Contrib\Language files\English.nlf"
LangString appCannotBeClosed 1033 "The fixture payload is locked."
!include "${nsisString(path.join(includes, 'extractAppPackage.nsh'))}"
Var fixtureArchive
Var fixtureReport
Var fixtureHandle
Section
  InitPluginsDir
  ReadEnvStr $INSTDIR "LIFE_NSIS_PAYLOAD_FIXTURE_TARGET"
  ReadEnvStr $fixtureArchive "LIFE_NSIS_PAYLOAD_FIXTURE_ARCHIVE"
  ReadEnvStr $fixtureReport "LIFE_NSIS_PAYLOAD_FIXTURE_RESULT"
  SetOutPath "$INSTDIR"
  !insertmacro extractUsing7za "$fixtureArchive"
  FileOpen $fixtureHandle "$fixtureReport.registered" w
  IfErrors fixture_failed
  FileClose $fixtureHandle
  FileOpen $fixtureHandle "$fixtureReport.launched" w
  IfErrors fixture_failed
  FileClose $fixtureHandle
  FileOpen $fixtureHandle "$fixtureReport" w
  IfErrors fixture_failed
  FileWrite $fixtureHandle "ok$\r$\n"
  FileClose $fixtureHandle
  SetErrorLevel 0
  Goto fixture_complete
  fixture_failed:
    SetErrorLevel 7
    Quit
  fixture_complete:
SectionEnd
`,
    )
    requireSuccess(binary.path, ['-WX', '-V2', '-INPUTCHARSET', 'UTF8', controlSource], {
      env: { ...process.env, ...binary.env },
    })
    const largePayload = path.join(scratch, 'large-trusted-payload')
    fs.cpSync(payload, largePayload, { recursive: true })
    const largeBytes = Buffer.alloc(64 * 1024 * 1024)
    for (let i = 0; i < largeBytes.length; i++) {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      largeBytes[i] = state & 0xff
    }
    fs.writeFileSync(path.join(largePayload, 'large.bin'), largeBytes)
    fixPayloadTimes(largePayload)
    const largeArchive = archive(largePayload, 'large-good.7z')
    const largeExecutable = path.join(scratch, 'large-fixture.exe')
    const largeSource = path.join(scratch, 'large-fixture.nsi')
    fs.writeFileSync(
      largeSource,
      fs
        .readFileSync(source, 'utf8')
        .replace(
          `OutFile "${nsisString(executable)}"`,
          () => `OutFile "${nsisString(largeExecutable)}"`,
        )
        .replace(
          `!define APP_64 "${nsisString(good)}"`,
          () => `!define APP_64 "${nsisString(largeArchive)}"`,
        ),
    )
    requireSuccess(binary.path, ['-WX', '-V2', '-INPUTCHARSET', 'UTF8', largeSource], {
      env: { ...process.env, ...binary.env },
    })
    let legacyLargeExecutable = largeExecutable
    if (modern) {
      legacyLargeExecutable = path.join(scratch, 'large-legacy-fixture.exe')
      const legacyLargeSource = path.join(scratch, 'large-legacy-fixture.nsi')
      fs.writeFileSync(
        legacyLargeSource,
        fs
          .readFileSync(largeSource, 'utf8')
          .replace(
            '!define LIFE_MODERN_ENABLED',
            '; Explicit legacy control for the original interruption proof',
          )
          .replace(
            `OutFile "${nsisString(largeExecutable)}"`,
            () => `OutFile "${nsisString(legacyLargeExecutable)}"`,
          ),
      )
      requireSuccess(binary.path, ['-WX', '-V2', '-INPUTCHARSET', 'UTF8', legacyLargeSource], {
        env: { ...process.env, ...binary.env },
      })
    }
    const unavailableExecutable = path.join(scratch, 'hash-unavailable-fixture.exe')
    const unavailableSource = path.join(scratch, 'hash-unavailable-fixture.nsi')
    fs.writeFileSync(
      unavailableSource,
      fs
        .readFileSync(source, 'utf8')
        .replace(
          'Unicode true',
          'Unicode true\n!define LIFE_INSTALLER_HASH_FIXTURE\n!define LIFE_NATIVE_HASH_FIXTURE_UNAVAILABLE',
        )
        .replace(
          `OutFile "${nsisString(executable)}"`,
          () => `OutFile "${nsisString(unavailableExecutable)}"`,
        ),
    )
    requireSuccess(binary.path, ['-WX', '-V2', '-INPUTCHARSET', 'UTF8', unavailableSource], {
      env: { ...process.env, ...binary.env },
    })
    const collisionExecutable = path.join(scratch, 'guard-collision-fixture.exe')
    const collisionSource = path.join(scratch, 'guard-collision-fixture.nsi')
    fs.writeFileSync(
      collisionSource,
      fs
        .readFileSync(source, 'utf8')
        .replace(
          `OutFile "${nsisString(executable)}"`,
          () => `OutFile "${nsisString(collisionExecutable)}"`,
        )
        .replace(
          `!define APP_64 "${nsisString(good)}"`,
          () => `!define APP_64 "${nsisString(collisionArchive)}"`,
        ),
    )
    requireSuccess(binary.path, ['-WX', '-V2', '-INPUTCHARSET', 'UTF8', collisionSource], {
      env: { ...process.env, ...binary.env },
    })
    let launcherFixtureExecutable
    if (modern) {
      launcherFixtureExecutable = path.join(scratch, 'launcher-fault-fixture.exe')
      const launcherFixtureSource = path.join(scratch, 'launcher-fault-fixture.nsi')
      fs.writeFileSync(
        launcherFixtureSource,
        fs
          .readFileSync(source, 'utf8')
          .replace('Unicode true', 'Unicode true\n!define LIFE_LAUNCHER_NATIVE_FIXTURE')
          .replace(
            `OutFile "${nsisString(executable)}"`,
            () => `OutFile "${nsisString(launcherFixtureExecutable)}"`,
          )
          .replace(
            `!define LIFE_MODERN_PLUGIN_DIR "${nsisString(modern.pluginDirectory)}"`,
            () => `!define LIFE_MODERN_PLUGIN_DIR "${nsisString(modern.fixturePluginDirectory)}"`,
          ),
      )
      requireSuccess(binary.path, ['-WX', '-V2', '-INPUTCHARSET', 'UTF8', launcherFixtureSource], {
        env: { ...process.env, ...binary.env },
      })
    }
    if (process.platform !== 'win32') {
      console.log(
        'Real NSIS payload, unchanged stock-control, large-interruption and forced-unavailable hash fixtures compiled; CRC and truncated archives rejected. Native runtime assertions require Windows.',
      )
      return
    }

    let trials = 0
    const nativeTemp = path.join(scratch, 'native-temp')
    fs.mkdirSync(nativeTemp)
    function execute(
      name,
      mode,
      target,
      expected,
      filename = good,
      succeeds = true,
      nativeExecutable = executable,
      fixtureEnvironment = {},
    ) {
      trials++
      const report = path.join(scratch, `${name}.result`)
      const trace = path.join(scratch, `${name}.trace.tsv`)
      const result = run(nativeExecutable, ['/S'], {
        env: {
          ...process.env,
          TEMP: nativeTemp,
          TMP: nativeTemp,
          LIFE_NSIS_PAYLOAD_FIXTURE_MODE: mode,
          LIFE_NSIS_PAYLOAD_FIXTURE_TARGET: target,
          LIFE_NSIS_PAYLOAD_FIXTURE_EXPECTED: String(expected),
          LIFE_NSIS_PAYLOAD_FIXTURE_RESULT: report,
          LIFE_NSIS_PAYLOAD_FIXTURE_ARCHIVE: filename,
          LIFE_NSIS_TRACE_FILE: trace,
          ...fixtureEnvironment,
        },
      })
      const diagnosticFile = `${report}.diagnostic.txt`
      const diagnostic = fs.existsSync(diagnosticFile)
        ? fs.readFileSync(diagnosticFile, 'utf16le')
        : ''
      if (diagnostic)
        console.error(`${name}: native fixture diagnostic before cleanup:\n${diagnostic}`)
      if (succeeds) {
        assert.equal(
          result.status,
          0,
          `${name}: native assertions failed (${result.status})\n${result.stdout}\n${result.stderr}\n${diagnostic || 'Native diagnostic not produced.'}`,
        )
        assert.equal(
          fs.readFileSync(report, 'utf8'),
          'ok\r\n',
          `${name}: assertions did not complete`,
        )
      } else {
        assert.equal(
          result.status,
          2,
          `${name}: invalid payload must exit with the verification failure code`,
        )
        assert.equal(
          fs.existsSync(report),
          false,
          `${name}: invalid payload reached successful completion`,
        )
      }
      for (const action of ['registered', 'launched']) {
        assert.equal(
          fs.existsSync(`${report}.${action}`),
          mode.startsWith('extract') && succeeds,
          `${name}: ${action} sentinel has the wrong fail-closed state`,
        )
      }
      if (!fs.existsSync(trace)) return []
      let previous = 0
      return fs
        .readFileSync(trace, 'ascii')
        .trim()
        .split(/\r?\n/)
        .map((line) => {
          assert.match(line, /^[a-z-]+\t\d+$/, `${name}: malformed native trace marker`)
          const [phase, value] = line.split('\t')
          const uptime = Number(value)
          assert.ok(
            Number.isSafeInteger(uptime) && uptime > 0 && uptime >= previous,
            `${name}: native trace uptime must be positive and monotonic`,
          )
          previous = uptime
          return phase
        })
    }

    function directory(name, copyPayload = false) {
      const target = path.join(scratch, name)
      if (copyPayload) fs.cpSync(payload, target, { recursive: true })
      else fs.mkdirSync(target)
      return target
    }
    // Rename publication needs write access to its immediate parent. Keep
    // controls below a fresh directory outside every pinned launch ancestry.
    const observerControls = directory('launcher-observer-controls')
    function assertControlIsolation(...launchPaths) {
      for (const filename of launchPaths) {
        const relative = path.relative(observerControls, filename)
        assert.ok(
          relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
          `Launcher input/output would pin the control directory: ${filename}`,
        )
      }
    }
    function observerConfig(name, parentImage, decoderRoot, decoderSuffix, mode, report) {
      return {
        OwnedRoot: scratch,
        ReadyFile: path.join(observerControls, `${name}.observer-ready`),
        ParentPidFile: `${report}.pid`,
        ObservedFile: path.join(observerControls, `${name}.observer-observed.json`),
        ResultFile: path.join(observerControls, `${name}.observer-result.json`),
        KillRequestFile: path.join(observerControls, `${name}.observer-kill`),
        RequestToken: name,
        ParentImage: parentImage,
        DecoderRoot: decoderRoot,
        DecoderSuffix: decoderSuffix,
        DecoderSha256: sha256(modern.decoder),
        Mode: mode,
      }
    }
    function mutationProbe(target, outside, sentinel, lease) {
      const result = requireSuccess(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          modern.mutationSource,
        ],
        {
          env: windowsPowerShellEnvironment({
            ...process.env,
            TEMP: nativeTemp,
            TMP: nativeTemp,
            LIFE_FIXTURE_MUTATION_ROOT: scratch,
            LIFE_FIXTURE_MUTATION_SOURCE: modern.mutationNativeSource,
            LIFE_FIXTURE_MUTATION_TARGET: target,
            LIFE_FIXTURE_MUTATION_OUTSIDE: outside,
            LIFE_FIXTURE_MUTATION_SENTINEL: sentinel,
            LIFE_FIXTURE_MUTATION_LEASE: lease || '',
          }),
        },
      )
      const diagnostic = JSON.parse(result.stdout.trim())
      console.log(`Native directory mutation evidence: ${JSON.stringify(diagnostic)}`)
      return diagnostic
    }

    assert.ok(modern, 'Windows native assertions must use the prepared modern backend')
    const rawDecoderDirectory = directory("launcher decoder 研究$-'quote-`tick")
    const rawDecoder = path.join(rawDecoderDirectory, "7za decoder $-'quote-`tick.exe")
    fs.copyFileSync(modern.decoder, rawDecoder)
    assert.equal(sha256(rawDecoder), sha256(modern.decoder))
    const rawArchive = path.join(scratch, "launcher archive 研究$-'quote-`tick.7z")
    fs.copyFileSync(good, rawArchive)
    function rawLaunch(
      name,
      decoder,
      filename,
      expected,
      mode = 'launch',
      heldFile,
      suppliedOutput,
    ) {
      const output = suppliedOutput || directory(`launcher output ${name} 研究$-'quote-\`tick`)
      const warmOutput = directory(`launcher warm ${name}`)
      const before = inventory(output)
      execute(`launcher-${name}`, mode, heldFile || output, expected, filename, true, executable, {
        LIFE_NSIS_PAYLOAD_FIXTURE_DECODER: decoder,
        LIFE_NSIS_PAYLOAD_FIXTURE_OUTPUT: `${output}\\`,
        LIFE_NSIS_PAYLOAD_FIXTURE_WARM_OUTPUT: warmOutput,
      })
      assert.deepEqual(
        inventory(warmOutput),
        inventory(payload),
        'Launcher warm-up must actually extract the trusted tree',
      )
      if (expected === 'ok')
        assert.deepEqual(
          inventory(output),
          inventory(payload),
          'Raw modern launch must produce every trusted hash and literal filename',
        )
      else if (expected === 'unavailable')
        assert.deepEqual(
          inventory(output),
          before,
          'Unavailable launcher must not write any output',
        )
      return output
    }
    rawLaunch('literal-paths', rawDecoder, rawArchive, 'ok')
    rawLaunch('missing-exe', path.join(scratch, 'missing-decoder.exe'), rawArchive, 'unavailable')
    rawLaunch(
      'missing-archive',
      rawDecoder,
      path.join(scratch, 'missing-launch-archive.7z'),
      'unavailable',
    )
    rawLaunch('crc', rawDecoder, corrupt, 'error')
    rawLaunch('truncated', rawDecoder, truncated, 'error')
    for (const [name, heldFile] of [
      ['held-decoder', rawDecoder],
      ['held-archive', rawArchive],
    ]) {
      const beforeHash = sha256(heldFile)
      rawLaunch(name, rawDecoder, rawArchive, 'unavailable', 'launch-locked', heldFile)
      assert.equal(
        sha256(heldFile),
        beforeHash,
        'Launcher failure must preserve the independent caller writer handle and exact bytes',
      )
    }
    const linkedDecoder = path.join(scratch, 'linked-modern-decoder.exe')
    fs.symlinkSync(rawDecoder, linkedDecoder, 'file')
    rawLaunch('linked-decoder', linkedDecoder, rawArchive, 'unavailable')
    const linkedArchive = path.join(scratch, 'linked-modern-archive.7z')
    fs.symlinkSync(rawArchive, linkedArchive, 'file')
    rawLaunch('linked-archive', rawDecoder, linkedArchive, 'unavailable')
    const launcherOutside = directory('launcher-outside')
    const launcherOutsideSentinel = path.join(launcherOutside, 'outside-sentinel.txt')
    fs.writeFileSync(launcherOutsideSentinel, 'Retain outside launcher bytes\n')
    const launcherOutsideBefore = inventory(launcherOutside)
    const linkedOutput = path.join(scratch, 'linked-modern-output')
    fs.symlinkSync(launcherOutside, linkedOutput, 'junction')
    rawLaunch(
      'linked-output',
      rawDecoder,
      rawArchive,
      'unavailable',
      'launch',
      undefined,
      linkedOutput,
    )
    assert.deepEqual(inventory(launcherOutside), launcherOutsideBefore)
    const mutationBaseline = directory('launcher-unpinned-mutation-baseline')
    const baselineMutation = mutationProbe(
      mutationBaseline,
      launcherOutside,
      launcherOutsideSentinel,
    )
    assert.equal(
      baselineMutation.attrOpen,
      true,
      'Unpinned ordinary directory must establish actual attribute-only access',
    )
    assert.equal(
      baselineMutation.setReparse,
      true,
      'The same native FSCTL and exact buffer must establish a real unpinned junction before guard comparison',
    )
    assert.ok(fs.lstatSync(mutationBaseline).isSymbolicLink())
    fs.rmdirSync(mutationBaseline)
    assert.deepEqual(
      inventory(launcherOutside),
      launcherOutsideBefore,
      'Baseline native junction mutation must preserve every outside hash',
    )
    const guardCollision = directory('launcher-existing-guard')
    fs.writeFileSync(
      path.join(guardCollision, '.life-installer-extractor-guard'),
      'Unowned guard filename must remain intact\n',
    )
    rawLaunch(
      'existing-guard',
      rawDecoder,
      rawArchive,
      'unavailable',
      'launch',
      undefined,
      guardCollision,
    )

    for (const mode of ['pause-after-create', 'fail-job-query']) {
      const name = `launcher-fault-${mode}`
      const output = directory(`${name}-output`)
      const report = path.join(observerControls, `${name}.result`)
      const marker = path.join(observerControls, `${name}.created`)
      assertControlIsolation(modern.decoder, good, output)
      const config = {
        ...observerConfig(
          name,
          launcherFixtureExecutable,
          path.dirname(modern.decoder),
          path.basename(modern.decoder),
          mode === 'pause-after-create' ? 'MarkerKill' : 'MarkerExit',
          report,
        ),
        ChildPidFile: marker,
        AckFile: `${marker}.ack`,
      }
      const observer = await startDecoderObserver({
        scratch,
        name,
        source: modern.observerSource,
        config,
        env: { ...process.env, TEMP: nativeTemp, TMP: nativeTemp },
      })
      trials++
      const trial = fixtureChild(launcherFixtureExecutable, ['/S'], {
        ...process.env,
        TEMP: nativeTemp,
        TMP: nativeTemp,
        LIFE_NSIS_PAYLOAD_FIXTURE_MODE: 'launch-fixture',
        LIFE_NSIS_PAYLOAD_FIXTURE_TARGET: output,
        LIFE_NSIS_PAYLOAD_FIXTURE_EXPECTED: 'error',
        LIFE_NSIS_PAYLOAD_FIXTURE_RESULT: report,
        LIFE_NSIS_PAYLOAD_FIXTURE_ARCHIVE: good,
        LIFE_NSIS_PAYLOAD_FIXTURE_DECODER: modern.decoder,
        LIFE_NSIS_PAYLOAD_FIXTURE_OUTPUT: output,
        LIFE_NSIS_PAYLOAD_FIXTURE_LAUNCH_MARKER: marker,
        LIFE_NSIS_PAYLOAD_FIXTURE_LAUNCH_MODE: mode,
      })
      let faultFailure
      let mutation
      let trialExit
      trial.completion.then((exit) => {
        trialExit = exit
      })
      try {
        const pinned = await Promise.race([
          observer.observed(),
          trial.completion.then((exit) => {
            // A legitimate fatal77 can close before Node reads an already
            // published observation. Preserve that evidence and its gates.
            const observed = maybeRead(config.ObservedFile, 'utf8')
            if (observed !== undefined) return JSON.parse(observed)
            throw new Error(`${name}: NSIS exited before identities (${JSON.stringify(exit)})`)
          }),
        ])
        assert.equal(pinned.parentPid, trial.child.pid)
        assert.match(pinned.parentCreationTime, /^[1-9]\d+$/)
        assert.match(pinned.decoderCreationTime, /^[1-9]\d+$/)
        if (mode === 'pause-after-create') {
          const guard = path.join(output, '.life-installer-extractor-guard')
          assert.deepEqual(
            fs.readdirSync(output),
            ['.life-installer-extractor-guard'],
            'Paused launch must hold only its exact owned guard before ResumeThread',
          )
          assert.ok(fs.lstatSync(guard).isFile() && !fs.lstatSync(guard).isSymbolicLink())
          assert.deepEqual(
            fs.readFileSync(guard),
            Buffer.from('L'),
            'Handle-relative guard must exist inside the actual owned output directory',
          )
          mutation = mutationProbe(output, launcherOutside, launcherOutsideSentinel, guard)
          const renamed = `${output}.renamed`
          let renameError
          try {
            fs.renameSync(output, renamed)
            fs.renameSync(renamed, output)
          } catch (error) {
            renameError = error
          }
          assert.ok(
            renameError && ['EACCES', 'EPERM', 'EBUSY'].includes(renameError.code),
            'Pinned output directory must reject rename before child resume',
          )
          fs.writeFileSync(config.KillRequestFile + '.pending', config.RequestToken + '\r\n', {
            flag: 'wx',
          })
          fs.renameSync(config.KillRequestFile + '.pending', config.KillRequestFile)
        }
        const lifetime = await observer.result()
        const exit = await bounded(
          trial.completion,
          10000,
          `${name}: NSIS original child handle did not close`,
        )
        assert.equal(lifetime.ParentPid, trial.child.pid)
        assert.equal(lifetime.ParentWait, 0)
        assert.equal(lifetime.DecoderWait, 0)
        assert.equal(
          fs.existsSync(path.join(output, '.life-installer-extractor-guard')),
          false,
          'Both exact process exits must release the owned guard before cleanup or verification',
        )
        if (mode === 'fail-job-query') {
          assert.equal(exit.code, 77)
          assert.equal(lifetime.ParentExit, 77)
          assert.equal(lifetime.DecoderExit, 0)
          assert.equal(lifetime.ParentKilled, false)
          assert.equal(
            fs.readFileSync(config.AckFile, 'ascii'),
            'LIFE_LAUNCHER_OBSERVER_READY_V1\n',
          )
        } else {
          assert.equal(lifetime.ParentKilled, true)
          assert.ok(exit.code !== 0 || exit.signal)
        }
        assert.deepEqual(
          inventory(launcherOutside),
          launcherOutsideBefore,
          'Paused/fatal launcher must preserve the complete outside tree and every hash',
        )
        if (mutation?.setReparse) {
          assert.ok(fs.lstatSync(output).isSymbolicLink())
          fs.rmdirSync(output)
          fs.mkdirSync(output)
        }
        assert.ok(fs.lstatSync(output).isDirectory() && !fs.lstatSync(output).isSymbolicLink())
        if (mode === 'fail-job-query') {
          const completedInventory = inventory(output)
          assert.deepEqual(
            completedInventory,
            inventory(payload),
            'Forced accounting failure after decoder exit 0 must retain every trusted payload hash',
          )
          for (const entry of completedInventory.filter((item) => !item.directory))
            assert.equal(
              fs.statSync(path.join(output, entry.name)).size,
              fs.statSync(path.join(payload, entry.name)).size,
              'Completed fatal-query payload must retain each exact trusted file size',
            )
          await new Promise((resolve) => setTimeout(resolve, 25))
          assert.deepEqual(
            inventory(output),
            completedInventory,
            'Fatal-query payload cannot change after both exact process waits',
          )
        } else
          assert.deepEqual(
            fs.readdirSync(output),
            [],
            'A decoder suspended before extraction must leave its output exactly empty',
          )
        for (const item of [report, `${report}.registered`, `${report}.launched`])
          assert.equal(
            fs.existsSync(item),
            false,
            'Faulted native launcher cannot produce a successful result, registration or launch',
          )
        if (mutation) {
          assert.equal(mutation.writeOpen, false)
          assert.equal(
            mutation.writeError,
            32,
            'Actual generic-write handle must fail with sharing violation',
          )
          assert.equal(
            mutation.setReparse,
            false,
            'Actual attribute-only junction mutation must fail while the owned guard is held',
          )
          assert.ok(mutation.setReparseError > 0)
          assert.equal(mutation.targetAttributesAfter & 0x410, 0x10)
          assert.deepEqual(mutation.targetEntries, [
            path.join(output, '.life-installer-extractor-guard'),
          ])
          const renamed = `${output}.after-exit`
          fs.renameSync(output, renamed)
          fs.renameSync(renamed, output)
        }
      } catch (error) {
        faultFailure = error
        try {
          const rawFiles = [
            [`${report}.pid`, 'ascii'],
            [marker, 'utf16le'],
          ].map(([filename, encoding]) => {
            const bytes = maybeRead(filename)
            return {
              filename,
              bytes: bytes?.length,
              hex: bytes?.toString('hex'),
              text: bytes?.toString(encoding),
            }
          })
          console.error(
            `${name} original child evidence before cleanup: ${JSON.stringify({
              exit: trialExit || { running: true, pid: trial.child.pid },
              result: maybeRead(report, 'utf8'),
              diagnostic: maybeRead(`${report}.diagnostic.txt`, 'utf16le'),
              rawFiles,
            })}`,
          )
        } catch (diagnosticError) {
          faultFailure = new AggregateError(
            [error, diagnosticError],
            `${name}: original failure and evidence capture failure`,
          )
        }
      } finally {
        const cleanupErrors = []
        if (faultFailure) {
          trial.child.kill('SIGKILL')
          try {
            await bounded(trial.completion, 10000, `${name} failed NSIS did not terminate`)
          } catch (error) {
            cleanupErrors.push(error)
          }
          try {
            const exit = await bounded(
              observer.completion,
              35000,
              `${name} failed observer did not release exact process handles`,
            )
            if (exit.code !== 0)
              cleanupErrors.push(
                new Error(
                  `${name} observer teardown: ${maybeRead(config.ResultFile, 'utf8') || JSON.stringify(exit)}`,
                ),
              )
          } catch (error) {
            cleanupErrors.push(error)
          }
          try {
            if (fs.lstatSync(output).isSymbolicLink()) {
              fs.rmdirSync(output)
              fs.mkdirSync(output)
            }
            assert.deepEqual(inventory(launcherOutside), launcherOutsideBefore)
          } catch (error) {
            cleanupErrors.push(error)
          }
        }
        finishFixtureCleanup(
          faultFailure,
          () => {
            if (cleanupErrors.length)
              throw new AggregateError(cleanupErrors, `${name} safe teardown failed`)
          },
          name,
        )
      }
    }

    for (const [descendantMode, descendantName, expectedRootExit] of [
      ['spawn-descendant-nonzero', 'launcher-descendant', 9],
      ['spawn-descendant-zero', 'launcher-descendant-zero', 0],
    ]) {
      const descendantOutput = directory(`${descendantName}-output`)
      const descendantWarm = directory(`${descendantName}-warm`)
      const descendantWitness = path.join(observerControls, `${descendantName}-witness`)
      const descendantConfig = path.join(scratch, `${descendantName}-config.txt`)
      const descendantReport = path.join(observerControls, `${descendantName}.result`)
      assertControlIsolation(modern.fakeExecutable, descendantConfig, descendantOutput)
      fs.writeFileSync(
        descendantConfig,
        `mode=${descendantMode}\nroot=${scratch}\nwitness=${descendantWitness}\nexe=${modern.fakeExecutable}\n`,
      )
      const descendantObserver = fixtureChild(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          modern.fakeObserverSource,
        ],
        windowsPowerShellEnvironment({
          ...process.env,
          TEMP: nativeTemp,
          TMP: nativeTemp,
          LIFE_FIXTURE_OBSERVER_ROOT: scratch,
          LIFE_FIXTURE_OBSERVER_SOURCE: modern.fakeSource,
          LIFE_FIXTURE_OBSERVER_WITNESS: descendantWitness,
          LIFE_FIXTURE_OBSERVER_EXE: modern.fakeExecutable,
          LIFE_FIXTURE_OBSERVER_OUTPUT: descendantOutput,
          LIFE_FIXTURE_OBSERVER_ROOT_EXIT: String(expectedRootExit),
        }),
      )
      trials++
      const descendantTrial = fixtureChild(executable, ['/S'], {
        ...process.env,
        TEMP: nativeTemp,
        TMP: nativeTemp,
        LIFE_NSIS_PAYLOAD_FIXTURE_MODE: 'launch-once',
        LIFE_NSIS_PAYLOAD_FIXTURE_TARGET: descendantOutput,
        LIFE_NSIS_PAYLOAD_FIXTURE_EXPECTED: 'error',
        LIFE_NSIS_PAYLOAD_FIXTURE_RESULT: descendantReport,
        LIFE_NSIS_PAYLOAD_FIXTURE_ARCHIVE: descendantConfig,
        LIFE_NSIS_PAYLOAD_FIXTURE_DECODER: modern.fakeExecutable,
        LIFE_NSIS_PAYLOAD_FIXTURE_OUTPUT: descendantOutput,
        LIFE_NSIS_PAYLOAD_FIXTURE_WARM_OUTPUT: descendantWarm,
        LIFE_NSIS_PAYLOAD_FIXTURE_DESCENDANT_PID_FILE: `${descendantWitness}.pid`,
      })
      let descendantFailure
      try {
        const pinned = JSON.parse(
          await waitFixtureFile(
            `${descendantWitness}.observer-ready.json`,
            30000,
            'Pinned live fake descendant',
            descendantObserver.completion,
          ),
        )
        assert.ok(pinned.ProgressBytes > pinned.FirstBytes && pinned.FirstBytes > 0)
        assert.match(pinned.Creation, /^[1-9]\d+$/)
        assert.match(pinned.RootCreation, /^[1-9]\d+$/)
        assert.notEqual(pinned.RootPid, pinned.Pid)
        const exit = await bounded(
          descendantTrial.completion,
          30000,
          'Raw launcher did not return after failing decoder',
        )
        const diagnostic = maybeRead(`${descendantReport}.diagnostic.txt`, 'utf16le')
        if (diagnostic) console.error(`${descendantMode} boundary diagnostic:\n${diagnostic}`)
        assert.equal(
          exit.code,
          0,
          `Raw launcher descendant proof failed\n${JSON.stringify(exit)}\n${diagnostic}`,
        )
        assert.equal(fs.readFileSync(descendantReport, 'utf8'), 'ok\r\n')
        fs.writeFileSync(`${descendantWitness}.launch-complete`, 'error\n', { flag: 'wx' })
        const observerExit = await bounded(
          descendantObserver.completion,
          30000,
          'Pinned descendant observer did not terminate',
        )
        const finished = maybeRead(`${descendantWitness}.observer-finished.json`, 'utf8')
        console.log(
          `${descendantMode} native descendant lifetime evidence: ${finished || JSON.stringify(observerExit)}`,
        )
        assert.equal(observerExit.code, 0, observerExit.stderr)
        const final = JSON.parse(finished)
        assert.equal(final.Pid, pinned.Pid)
        assert.equal(final.Creation, pinned.Creation)
        assert.equal(final.Image, pinned.Image)
        assert.equal(final.RootPid, pinned.RootPid)
        assert.equal(final.RootCreation, pinned.RootCreation)
        assert.equal(final.RootImage, pinned.RootImage)
        assert.equal(final.RootExitCode, expectedRootExit)
        assert.equal(final.Sha256, sha256(path.join(descendantOutput, 'descendant-writes.bin')))
        assert.equal(
          final.Bytes,
          fs.statSync(path.join(descendantOutput, 'descendant-writes.bin')).size,
        )
        assert.deepEqual(
          fs.readdirSync(descendantOutput),
          ['descendant-writes.bin'],
          'Raw descendant failure must remove its owned guard before reporting completion',
        )
        for (const action of ['registered', 'launched'])
          assert.equal(fs.existsSync(`${descendantReport}.${action}`), false)
      } catch (error) {
        descendantFailure = error
      } finally {
        const cleanupErrors = []
        if (descendantFailure) {
          descendantTrial.child.kill('SIGKILL')
          try {
            await bounded(
              descendantTrial.completion,
              10000,
              'Failed raw descendant fixture did not terminate',
            )
          } catch (error) {
            cleanupErrors.push(error)
          }
          if (!fs.existsSync(`${descendantWitness}.launch-complete`))
            try {
              fs.writeFileSync(`${descendantWitness}.launch-complete`, 'error\n', { flag: 'wx' })
            } catch (error) {
              cleanupErrors.push(error)
            }
          try {
            const exit = await bounded(
              descendantObserver.completion,
              35000,
              'Failed descendant observer did not release its pinned handles',
            )
            if (exit.code !== 0)
              cleanupErrors.push(new Error(`Descendant observer teardown: ${JSON.stringify(exit)}`))
          } catch (error) {
            cleanupErrors.push(error)
          }
        }
        finishFixtureCleanup(
          descendantFailure,
          () => {
            if (cleanupErrors.length)
              throw new AggregateError(cleanupErrors, 'Descendant native teardown failed')
          },
          descendantMode,
        )
      }
    }

    const hashVectors = directory('native-hash-vectors')
    const multichunkBytes = Buffer.alloc(2 * 1024 * 1024 + 133)
    for (let index = 0; index < multichunkBytes.length; index++) {
      multichunkBytes[index] = bytes[index % bytes.length]
    }
    const vectors = [
      ['empty', 'empty.bin', Buffer.alloc(0)],
      ['tiny', 'tiny-abc.txt', Buffer.from('abc')],
      ['multichunk', 'multichunk.bin', multichunkBytes],
      ['truncated-stable', 'truncated-stable.bin', multichunkBytes.subarray(0, -1)],
      ['unicode-literals', "研究$-'quote-`tick.txt", Buffer.from('Life payload fixture\n')],
    ]
    const knownVectorHashes = new Map()
    for (const [name, filename, data] of vectors) {
      const target = path.join(hashVectors, filename)
      fs.writeFileSync(target, data)
      const expected = createHash('sha256').update(data).digest('hex')
      knownVectorHashes.set(name, { target, expected })
      if (name === 'empty') {
        assert.equal(expected, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
      } else if (name === 'tiny') {
        assert.equal(expected, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
      }
      execute(`hash-native-${name}`, 'hash-native', target, expected)
      execute(`hash-wrapper-${name}`, 'hash-wrapper', target, expected)
      execute(`hash-stock-${name}`, 'hash-stock', target, expected)
      execute(
        `hash-unavailable-raw-${name}`,
        'hash-native',
        target,
        'unavailable',
        good,
        true,
        unavailableExecutable,
      )
      execute(
        `hash-unavailable-wrapper-${name}`,
        'hash-wrapper',
        target,
        expected,
        good,
        true,
        unavailableExecutable,
      )
      assert.equal(sha256(target), expected, 'Hashing must leave known vector bytes unchanged')
    }
    assert.notEqual(
      knownVectorHashes.get('truncated-stable').expected,
      knownVectorHashes.get('multichunk').expected,
      'A stable truncated file must hash its actual shorter content',
    )
    const diagnosticReport = path.join(scratch, 'native-hash-diagnostic-probe.result')
    const diagnosticExpected = '0'.repeat(64)
    const diagnosticResult = run(executable, ['/S'], {
      env: {
        ...process.env,
        TEMP: nativeTemp,
        TMP: nativeTemp,
        LIFE_NSIS_PAYLOAD_FIXTURE_MODE: 'hash-native',
        LIFE_NSIS_PAYLOAD_FIXTURE_TARGET: knownVectorHashes.get('tiny').target,
        LIFE_NSIS_PAYLOAD_FIXTURE_EXPECTED: diagnosticExpected,
        LIFE_NSIS_PAYLOAD_FIXTURE_RESULT: diagnosticReport,
        LIFE_NSIS_PAYLOAD_FIXTURE_ARCHIVE: good,
      },
    })
    assert.equal(
      diagnosticResult.status,
      7,
      'Wrong expected SHA must retain the fixture failure exit',
    )
    assert.equal(
      fs.existsSync(diagnosticReport),
      false,
      'Diagnostic failure must not report success',
    )
    const diagnosticText = fs.readFileSync(`${diagnosticReport}.diagnostic.txt`, 'utf16le')
    const diagnosticFields = Object.fromEntries(
      diagnosticText
        .trim()
        .split(/\r?\n/)
        .map((line) => {
          const separator = line.indexOf('=')
          assert.ok(separator > 0, 'Native diagnostic must contain named fields')
          return [line.slice(0, separator), line.slice(separator + 1)]
        }),
    )
    assert.equal(diagnosticFields.mode, 'hash-native')
    assert.equal(diagnosticFields.stage, 'result')
    assert.equal(diagnosticFields.target, knownVectorHashes.get('tiny').target)
    assert.equal(diagnosticFields.expected, diagnosticExpected)
    assert.equal(diagnosticFields.actual, knownVectorHashes.get('tiny').expected)
    for (const name of ['error-entry', 'error-exit', 'error-failure'])
      assert.equal(diagnosticFields[name], '0')
    assert.equal(diagnosticFields['pending-stack-top'], 'stack-top')
    assert.equal(diagnosticFields['pending-stack-bottom'], 'stack-bottom')
    assert.equal(diagnosticFields['checked-stack-top'], 'unobserved')
    assert.equal(diagnosticFields['checked-stack-bottom'], 'unobserved')
    for (const [index, register] of registers.entries()) {
      assert.equal(diagnosticFields[`register-${index} (${register})`], `register-${index}`)
    }
    assert.match(diagnosticFields['handles-before'], /^[1-9]\d*$/)
    assert.equal(diagnosticFields['handles-after'], '')
    console.log(
      'Native fixture failure diagnostic probe passed: exact failed hash, stage, registers, stack and flags retained before cleanup.',
    )
    const hashVectorsBefore = inventory(hashVectors)
    function hashRejected(name, target) {
      for (const [label, nativeExecutable] of [
        ['native', executable],
        ['provider-unavailable', unavailableExecutable],
      ]) {
        execute(
          `hash-reject-${label}-raw-${name}`,
          'hash-native',
          target,
          'error',
          good,
          true,
          nativeExecutable,
        )
        execute(
          `hash-reject-${label}-wrapper-${name}`,
          'hash-wrapper',
          target,
          'error',
          good,
          true,
          nativeExecutable,
        )
      }
    }
    hashRejected('missing', path.join(hashVectors, 'missing.bin'))
    hashRejected('directory', hashVectors)
    const writerTarget = knownVectorHashes.get('multichunk').target
    for (const [label, nativeExecutable] of [
      ['native', executable],
      ['provider-unavailable', unavailableExecutable],
    ]) {
      execute(
        `hash-held-writer-${label}-raw`,
        'hash-native-locked',
        writerTarget,
        'error',
        good,
        true,
        nativeExecutable,
      )
      execute(
        `hash-held-writer-${label}-wrapper`,
        'hash-wrapper-locked',
        writerTarget,
        'error',
        good,
        true,
        nativeExecutable,
      )
    }
    assert.deepEqual(inventory(hashVectors), hashVectorsBefore)
    execute(
      'hash-after-writer-closed',
      'hash-native',
      writerTarget,
      knownVectorHashes.get('multichunk').expected,
    )
    console.log(
      'Native CNG hash vectors passed: empty, abc, multichunk, stable shorter content and Unicode/dollar/quote/backtick filenames; exact stock and forced provider fallback parity, unsafe rejection, actual held-writer error 32, caller handle usability, 16 repetitions with all registers/stack/error states and no handle leaks.',
    )

    const metadataSource = path.join(scratch, 'metadata.ps1')
    fs.writeFileSync(metadataSource, '\ufeff' + metadataScript)
    const startupSource = path.join(scratch, 'powershell-startup.ps1')
    const startupOutput = path.join(scratch, 'powershell-startup.json')
    const poisonModules = directory('poisoned-powershell-modules')
    const poisonSecurity = path.join(poisonModules, 'Microsoft.PowerShell.Security')
    fs.mkdirSync(poisonSecurity)
    const poisonSentinel = 'LIFE_PS_MODULE_PATH_POISON_v1'
    fs.writeFileSync(path.join(poisonSecurity, 'poison.psm1'), `throw '${poisonSentinel}'\n`)
    fs.writeFileSync(
      path.join(poisonSecurity, 'Microsoft.PowerShell.Security.psd1'),
      String.raw`@{
  RootModule = 'poison.psm1'
  ModuleVersion = '99.0.0'
  GUID = '2e1cde56-39f2-43b1-b61c-d059cb469e10'
  FunctionsToExport = @('Get-Acl')
}
`,
    )
    fs.writeFileSync(
      startupSource,
      '\ufeff' +
        String.raw`$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
try {
  if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSEdition -ne 'Desktop') { throw 'The fixture requires native Windows PowerShell 5.' }
  Import-Module Microsoft.PowerShell.Security -ErrorAction Stop
  Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop
  $acl = Get-Acl -LiteralPath $env:LIFE_PS_STARTUP_DIRECTORY
  if ($acl -isnot [Security.AccessControl.DirectorySecurity]) { throw 'Get-Acl did not return the native .NET directory security object.' }
  $hash = Get-FileHash -LiteralPath $env:LIFE_PS_STARTUP_FILE -Algorithm SHA256
  $records = @()
  foreach ($name in @('Get-Acl', 'Get-FileHash', 'ConvertTo-Json')) {
    $command = Get-Command $name -ErrorAction Stop
    $expected = $(if ($name -eq 'Get-Acl') { 'Microsoft.PowerShell.Security' } else { 'Microsoft.PowerShell.Utility' })
    if ($command.ModuleName -cne $expected) { throw ('Unexpected native module for ' + $name) }
    $expectedBase = [IO.Path]::GetFullPath([IO.Path]::Combine($PSHOME, 'Modules', $expected))
    $nativeHome = [IO.Path]::GetFullPath($PSHOME)
    $actualBase = [IO.Path]::GetFullPath($command.Module.ModuleBase)
    if (-not $actualBase.Equals($expectedBase, [StringComparison]::OrdinalIgnoreCase) -and -not $actualBase.Equals($nativeHome, [StringComparison]::OrdinalIgnoreCase)) { throw ('Unexpected native module base for ' + $name + ': ' + $actualBase) }
    $actualPath = [IO.Path]::GetFullPath($command.Module.Path)
    if (-not $actualPath.StartsWith(($nativeHome + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw ('Unexpected native module path for ' + $name + ': ' + $actualPath) }
    $records += [PSCustomObject]@{ Command = $name; Module = $expected; ModuleBase = $actualBase; ModulePath = $actualPath }
  }
  $json = ConvertTo-Json -InputObject ([PSCustomObject]@{ Major = $PSVersionTable.PSVersion.Major; Edition = $PSVersionTable.PSEdition; Sha256 = $hash.Hash.ToLowerInvariant(); Modules = $records }) -Depth 4 -Compress
  [IO.File]::WriteAllText($env:LIFE_PS_STARTUP_OUTPUT, $json, [Text.UTF8Encoding]::new($false))
} catch {
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 9
}
`,
    )
    const beforeProcessEnvironment = { ...process.env }
    const poisonedCallerEnvironment = {
      ...windowsPowerShellEnvironment(process.env),
      TEMP: nativeTemp,
      TMP: nativeTemp,
      LIFE_PS_STARTUP_DIRECTORY: payload,
      LIFE_PS_STARTUP_FILE: path.join(payload, 'payload.bin'),
      LIFE_PS_STARTUP_OUTPUT: startupOutput,
      PSModulePath: poisonModules,
    }
    const beforeCallerEnvironment = { ...poisonedCallerEnvironment }
    const startupArgs = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      startupSource,
    ]
    const poisonedStartup = run('powershell.exe', startupArgs, { env: poisonedCallerEnvironment })
    assert.equal(
      poisonedStartup.status,
      9,
      'Unsanitized child must resolve and reject the fixture-owned poisoned module',
    )
    assert.ok(
      (poisonedStartup.stdout + poisonedStartup.stderr).includes(poisonSentinel),
      'Negative child must fail through the actual poisoned module import',
    )
    assert.equal(
      fs.existsSync(startupOutput),
      false,
      'Poisoned child must not produce a successful startup result',
    )
    const mixedCaseCallerEnvironment = {
      ...poisonedCallerEnvironment,
      psmodulepath: poisonModules,
      PsMoDuLePaTh: poisonModules,
    }
    const beforeMixedCaseEnvironment = { ...mixedCaseCallerEnvironment }
    const startupEnvironment = windowsPowerShellEnvironment(mixedCaseCallerEnvironment)
    assert.equal(
      Object.keys(startupEnvironment).some((key) => key.toUpperCase() === 'PSMODULEPATH'),
      false,
      'Child environment must remove every casing of PSModulePath',
    )
    requireSuccess('powershell.exe', startupArgs, { env: startupEnvironment })
    const startup = JSON.parse(fs.readFileSync(startupOutput, 'utf8'))
    assert.equal(startup.Major, 5)
    assert.equal(startup.Edition, 'Desktop')
    assert.equal(startup.Sha256, sha256(path.join(payload, 'payload.bin')))
    assert.deepEqual(
      startup.Modules.map((entry) => entry.Command),
      ['Get-Acl', 'Get-FileHash', 'ConvertTo-Json'],
    )
    assert.deepEqual(
      poisonedCallerEnvironment,
      beforeCallerEnvironment,
      'Startup probe must preserve its caller environment object',
    )
    assert.deepEqual(
      mixedCaseCallerEnvironment,
      beforeMixedCaseEnvironment,
      'Sanitization must preserve every original environment key/value',
    )
    assert.deepEqual(
      { ...process.env },
      beforeProcessEnvironment,
      'Startup probe must preserve the process environment',
    )
    console.log(
      'Native Windows PowerShell startup probe passed: poisoned inherited module rejected, sanitized child loaded native Security/Utility cmdlets, and caller environment remained unchanged.',
    )
    function metadata(name, target, action = 'snapshot') {
      const output = path.join(scratch, `${name}.metadata.json`)
      requireSuccess(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', metadataSource],
        {
          env: windowsPowerShellEnvironment({
            ...process.env,
            TEMP: nativeTemp,
            TMP: nativeTemp,
            LIFE_NSIS_METADATA_ROOT: target,
            LIFE_NSIS_METADATA_OUTPUT: output,
            LIFE_NSIS_METADATA_ACTION: action,
          }),
        },
      )
      const records = JSON.parse(fs.readFileSync(output, 'utf8'))
      assert.ok(
        Array.isArray(records) && records.length > 0,
        'Native metadata snapshot must contain the target root',
      )
      return records.map((record) => {
        if (record.Relative === '') delete record.DirectoryLastWriteUtcTicksInformational
        return record
      })
    }

    const rootSentinelBytes = Buffer.from('Life root stream sentinel', 'utf8')
    const expectedRootStream = {
      Name: 'life-fixture-root',
      Size: rootSentinelBytes.length,
      Sha256: createHash('sha256').update(rootSentinelBytes).digest('hex'),
    }
    const adsProbe = metadata(
      'native-directory-ads-probe',
      directory('native-directory-ads-probe'),
      'probe-ads',
    )
    assert.equal(adsProbe.length, 1, 'Native ADS roundtrip must leave the ordinary directory empty')
    assert.deepEqual(
      adsProbe[0].Streams,
      [expectedRootStream],
      'Native ADS create/read/enumeration must preserve independently known exact UTF-8 length and hash, without creating the missing read probe',
    )
    console.log(
      'Native directory ADS probe passed: exact UTF-8 bytes, independent length/hash, stream enumeration and noncreating missing-stream reads.',
    )

    for (const custom of [false, true]) {
      const label = custom ? 'custom-acl' : 'default-acl'
      const directTarget = directory(`metadata-direct-${label}`)
      const controlTarget = directory(`metadata-control-${label}`)
      const beforeDirect = metadata(
        `metadata-direct-${label}-before`,
        directTarget,
        custom ? 'customize' : 'snapshot',
      )
      const beforeControl = metadata(
        `metadata-control-${label}-before`,
        controlTarget,
        custom ? 'customize' : 'snapshot',
      )
      const directMetadataPhases = execute(`metadata-direct-${label}`, 'extract', directTarget, 1)
      assert.ok(
        directMetadataPhases.includes('payload-direct-start'),
        `${label}: metadata comparison must exercise direct extraction`,
      )
      assert.ok(
        directMetadataPhases.includes('modern-decoder-result-ok'),
        `${label}: metadata parity must exercise the actual modern decoder`,
      )
      execute(
        `metadata-control-${label}`,
        'extract',
        controlTarget,
        1,
        good,
        true,
        controlExecutable,
      )
      const afterDirect = metadata(`metadata-direct-${label}-after`, directTarget)
      const afterControl = metadata(`metadata-control-${label}-after`, controlTarget)
      assert.deepEqual(
        afterDirect,
        afterControl,
        `${label}: direct extraction must preserve stock hashes, SID ACLs, inheritance, owner/group, ordinary attributes, archived mtimes and ADS`,
      )
      assert.deepEqual(
        afterDirect.find((entry) => entry.Relative === ''),
        beforeDirect[0],
        `${label}: direct extraction must preserve the existing target root ACL, owner, attributes and ADS`,
      )
      assert.deepEqual(
        afterControl.find((entry) => entry.Relative === ''),
        beforeControl[0],
        `${label}: stock control must preserve the existing target root metadata`,
      )
      assert.deepEqual(
        inventory(directTarget),
        inventory(payload),
        `${label}: direct payload must remain exact`,
      )
      assert.deepEqual(
        inventory(controlTarget),
        inventory(payload),
        `${label}: stock payload control must remain exact`,
      )
      if (custom) {
        assert.equal(
          beforeDirect[0].DaclProtected,
          true,
          'Custom target ACL must be protected before extraction',
        )
        assert.deepEqual(
          beforeDirect[0].Streams,
          [expectedRootStream],
          'Custom empty target must contain the root ADS sentinel with independently known exact length and hash',
        )
        assert.deepEqual(
          beforeControl[0].Streams,
          [expectedRootStream],
          'Stock custom target must contain the same independently verified root ADS sentinel',
        )
      }
    }

    const ordinary = directory('guard-ordinary-empty')
    execute('guard-empty', 'guard', ordinary, 1)
    execute('guard-missing', 'guard', path.join(scratch, 'guard-missing'), 2)
    execute('guard-regular-file', 'guard', path.join(payload, 'payload.bin'), 2)
    const nonemptyFile = directory('guard-nonempty-file')
    fs.writeFileSync(path.join(nonemptyFile, 'keep.txt'), 'Keep this file\n')
    execute('guard-nonempty-file', 'guard', nonemptyFile, 0)
    const nonemptyDirectory = directory('guard-nonempty-directory')
    fs.mkdirSync(path.join(nonemptyDirectory, 'child'))
    execute('guard-nonempty-directory', 'guard', nonemptyDirectory, 0)
    const junction = path.join(scratch, 'guard-junction')
    fs.symlinkSync(ordinary, junction, 'junction')
    execute('guard-junction', 'guard', junction, 2)
    const ancestorTarget = directory('guard-ancestor-target')
    fs.mkdirSync(path.join(ancestorTarget, 'child'))
    const ancestorJunction = path.join(scratch, 'guard-ancestor-junction')
    fs.symlinkSync(ancestorTarget, ancestorJunction, 'junction')
    execute('guard-junction-ancestor', 'guard', path.join(ancestorJunction, 'child'), 2)
    const compressed = directory('guard-compressed')
    requireSuccess('compact.exe', ['/c', '/i', '/q', compressed])
    execute('guard-compressed', 'guard', compressed, 0)

    const verificationCases = []
    function verificationCase(name, mutate, required, exact, preflight = 1) {
      const target = directory(`verify-${name}`, true)
      mutate?.(target)
      verificationCases.push({ name, target, required, exact, preflight })
    }
    verificationCase('good', undefined, 1, 1)
    verificationCase(
      'same-size-tamper',
      (target) => {
        const tampered = Buffer.from(bytes)
        tampered[Math.floor(bytes.length / 2)] ^= 0x80
        fs.writeFileSync(path.join(target, 'payload.bin'), tampered)
      },
      0,
      0,
    )
    verificationCase('missing', (target) => fs.rmSync(path.join(target, 'payload.bin')), 0, 0)
    verificationCase(
      'missing-empty-directory',
      (target) => fs.rmdirSync(path.join(target, 'empty')),
      0,
      0,
    )
    verificationCase(
      'short',
      (target) => fs.writeFileSync(path.join(target, 'payload.bin'), bytes.subarray(0, -1)),
      0,
      0,
    )
    const shortenedPayloadFile = path.join(
      verificationCases.find((item) => item.name === 'short').target,
      'payload.bin',
    )
    const shortenedPayloadHash = createHash('sha256').update(bytes.subarray(0, -1)).digest('hex')
    assert.notEqual(shortenedPayloadHash, sha256(path.join(payload, 'payload.bin')))
    execute(
      'hash-shorter-trusted-payload-raw',
      'hash-native',
      shortenedPayloadFile,
      shortenedPayloadHash,
    )
    execute(
      'hash-shorter-trusted-payload-wrapper',
      'hash-wrapper',
      shortenedPayloadFile,
      shortenedPayloadHash,
    )
    verificationCase(
      'extra-file',
      (target) => fs.writeFileSync(path.join(target, 'extra.txt'), 'retained\n'),
      1,
      0,
    )
    verificationCase(
      'hidden-extra-file',
      (target) => {
        const filename = path.join(target, 'hidden-extra.txt')
        fs.writeFileSync(filename, 'Hidden unrelated data\n')
        requireSuccess('attrib.exe', ['+h', filename])
      },
      1,
      0,
    )
    verificationCase(
      'extra-subdirectory',
      (target) => fs.mkdirSync(path.join(target, 'extra-directory')),
      1,
      0,
    )
    verificationCase(
      'nested-extra-file',
      (target) => fs.writeFileSync(path.join(target, 'nested', 'extra.txt'), 'retained\n'),
      1,
      0,
    )
    verificationCase(
      'file-is-directory',
      (target) => {
        fs.rmSync(path.join(target, 'payload.bin'))
        fs.mkdirSync(path.join(target, 'payload.bin'))
      },
      0,
      0,
      0,
    )
    verificationCase(
      'nested-junction',
      (target) => {
        fs.rmSync(path.join(target, 'nested'), { recursive: true })
        fs.symlinkSync(path.join(payload, 'nested'), path.join(target, 'nested'), 'junction')
      },
      0,
      0,
      0,
    )
    const fileSymlinkOutside = directory('file-symlink-outside')
    fs.writeFileSync(path.join(fileSymlinkOutside, 'payload.bin'), bytes)
    fs.writeFileSync(path.join(fileSymlinkOutside, 'sentinel.txt'), 'Outside file remains intact\n')
    const fileSymlinkOutsideBefore = inventory(fileSymlinkOutside)
    const fileSymlinkTarget = directory('verify-file-symlink', true)
    const expectedFileSymlink = path.join(fileSymlinkTarget, 'payload.bin')
    fs.rmSync(expectedFileSymlink)
    fs.symlinkSync(path.join(fileSymlinkOutside, 'payload.bin'), expectedFileSymlink, 'file')
    assert.ok(fs.lstatSync(expectedFileSymlink).isSymbolicLink())
    assert.equal(sha256(expectedFileSymlink), sha256(path.join(payload, 'payload.bin')))
    hashRejected('expected-file-symlink', expectedFileSymlink)
    verificationCases.push({
      name: 'file-symlink',
      target: fileSymlinkTarget,
      required: 0,
      exact: 0,
      preflight: 0,
    })
    const rootJunction = path.join(scratch, 'verify-root-junction')
    fs.symlinkSync(payload, rootJunction, 'junction')
    verificationCases.push({
      name: 'root-junction',
      target: rootJunction,
      required: 0,
      exact: 0,
      preflight: 0,
    })
    verificationCases.push({
      name: 'missing-directory',
      target: path.join(scratch, 'verify-missing-directory'),
      required: 0,
      exact: 0,
      preflight: 0,
    })
    for (const item of verificationCases) {
      execute(`required-${item.name}`, 'required', item.target, item.required)
      execute(`exact-${item.name}`, 'exact', item.target, item.exact)
      execute(`preflight-${item.name}`, 'preflight', item.target, item.preflight)
    }
    execute('preflight-empty', 'preflight', ordinary, 1)
    assert.deepEqual(
      execute('extract-file-symlink', 'extract', fileSymlinkTarget, 0, good, false),
      [],
      'Expected-file symlink must be rejected before extraction or copying',
    )
    assert.ok(fs.lstatSync(expectedFileSymlink).isSymbolicLink())
    assert.deepEqual(
      inventory(fileSymlinkOutside),
      fileSymlinkOutsideBefore,
      'Rejected expected-file symlink must preserve every outside hash',
    )

    const deniedTarget = directory('verify-native-access-denied', true)
    const deniedFile = path.join(deniedTarget, 'nested', '研究$', "entry-$value-'quote-`tick.txt")
    const deniedBefore = inventory(deniedTarget)
    const deniedFileHash = sha256(deniedFile)
    const deniedFileLength = fs.statSync(deniedFile).size
    const deniedParentEntries = fs.readdirSync(path.dirname(deniedFile)).sort()
    const deniedOutsideBefore = inventory(fileSymlinkOutside)
    const deniedSource = path.join(scratch, 'native-access-denied.ps1')
    const deniedBackup = path.join(scratch, 'native-access-denied.backup.json')
    fs.writeFileSync(deniedSource, '\ufeff' + accessDeniedScript)
    const expectedDeniedPaths = {
      Root: deniedTarget,
      File: deniedFile,
      Parent: path.dirname(deniedFile),
      Scratch: scratch,
    }
    function deniedAcl(
      action,
      scopeEnvironment = {},
      succeeds = true,
      name = action,
      rejection = 'Access denial must be confined to a nested, fixture-owned payload path.',
    ) {
      const output = path.join(scratch, `native-access-denied.${name}.json`)
      const child = run(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', deniedSource],
        {
          env: windowsPowerShellEnvironment({
            ...process.env,
            TEMP: nativeTemp,
            TMP: nativeTemp,
            LIFE_ACL_FIXTURE_ROOT: deniedTarget,
            LIFE_ACL_FIXTURE_FILE: deniedFile,
            LIFE_ACL_FIXTURE_SCRATCH: scratch,
            LIFE_ACL_FIXTURE_BACKUP: deniedBackup,
            LIFE_ACL_FIXTURE_OUTPUT: output,
            LIFE_ACL_FIXTURE_ACTION: action,
            ...scopeEnvironment,
          }),
        },
      )
      if (!succeeds) {
        assert.notEqual(child.status, 0, `${name}: outside fixture paths must be rejected`)
        assert.ok(
          (child.stdout + child.stderr).includes(rejection),
          `${name}: rejection must come from the actual checked normalization or containment guard`,
        )
        assert.equal(
          fs.existsSync(output),
          false,
          `${name}: rejected paths must not produce a result`,
        )
        assert.equal(
          fs.existsSync(deniedBackup),
          false,
          `${name}: rejected paths must not create an ACL backup`,
        )
        return undefined
      }
      assert.equal(child.status, 0, `powershell.exe failed:\n${child.stdout}\n${child.stderr}`)
      if (child.stderr.trim()) console.log(child.stderr.trim())
      return JSON.parse(fs.readFileSync(output, 'utf8'))
    }
    const beforeDeniedPaths = deniedAcl('probe-path', {}, true, 'paths-before-denial')
    assert.equal(beforeDeniedPaths.PathNormalizationStable, true)
    assert.deepEqual(beforeDeniedPaths.Paths, expectedDeniedPaths)
    assert.equal(
      fs.existsSync(deniedBackup),
      false,
      'Path-only probe must not prepare or modify ACLs',
    )
    deniedAcl(
      'probe-path',
      { LIFE_ACL_FIXTURE_FILE: path.join(fileSymlinkOutside, 'payload.bin') },
      false,
      'paths-outside-root',
    )
    deniedAcl(
      'probe-path',
      { LIFE_ACL_FIXTURE_FILE: path.join(`${deniedTarget}-sibling`, 'nested', 'payload.bin') },
      false,
      'paths-sibling-prefix',
    )
    const invalidAbsolutePath = 'ACL fixture paths must be bounded absolute drive paths'
    for (const [name, scopeEnvironment, rejection] of [
      [
        'paths-dotdot',
        { LIFE_ACL_FIXTURE_FILE: `${deniedTarget}\\..\\file-symlink-outside\\payload.bin` },
      ],
      [
        'paths-outside-scratch',
        {
          LIFE_ACL_FIXTURE_ROOT: `${scratch}-sibling`,
          LIFE_ACL_FIXTURE_FILE: path.join(`${scratch}-sibling`, 'nested', 'payload.bin'),
        },
      ],
      [
        'paths-relative',
        { LIFE_ACL_FIXTURE_FILE: path.relative(scratch, deniedFile) },
        invalidAbsolutePath,
      ],
      ['paths-device', { LIFE_ACL_FIXTURE_FILE: `\\\\.\\${deniedFile}` }, invalidAbsolutePath],
      ['paths-ads', { LIFE_ACL_FIXTURE_FILE: `${deniedFile}:fixture-scope` }, invalidAbsolutePath],
      [
        'paths-control',
        { LIFE_ACL_FIXTURE_FILE: `${deniedFile}\u0001` },
        'ACL fixture paths contain unsupported characters',
      ],
    ]) {
      deniedAcl('probe-path', scopeEnvironment, false, name, rejection)
    }
    assert.deepEqual(inventory(deniedTarget), deniedBefore)
    assert.deepEqual(inventory(fileSymlinkOutside), deniedOutsideBefore)
    const preparedAcl = deniedAcl('prepare-acl')
    assert.equal(preparedAcl.PathNormalizationStable, true)
    assert.deepEqual(preparedAcl.Paths, expectedDeniedPaths)
    for (const name of ['ParentControl', 'FileControl']) {
      assert.equal(
        preparedAcl.After[name],
        preparedAcl.Before[name] | 0x0400,
        'Fixture preparation must only establish the documented AI control flag',
      )
    }
    for (const name of Object.keys(preparedAcl.Before)) {
      if (['ParentAccess', 'FileAccess', 'ParentControl', 'FileControl'].includes(name)) continue
      assert.deepEqual(
        preparedAcl.After[name],
        preparedAcl.Before[name],
        `Fixture preparation must preserve the complete ordered ACL and existing metadata: ${name}`,
      )
    }
    assert.deepEqual(preparedAcl.After.ParentEntries, [path.basename(deniedFile)])
    assert.deepEqual(
      preparedAcl.Repeat,
      preparedAcl.After,
      'Fixture ACL preparation must be exactly stable on repeat',
    )
    assert.equal(
      fs.existsSync(deniedBackup),
      false,
      'ACL preparation must precede the saved denial baseline',
    )
    assert.deepEqual(
      inventory(deniedTarget),
      deniedBefore,
      'ACL preparation must preserve the entire payload inventory and hashes',
    )
    assert.deepEqual(
      inventory(fileSymlinkOutside),
      deniedOutsideBefore,
      'ACL preparation must preserve the outside inventory and hashes',
    )
    let deniedPrimaryFailure
    try {
      const denied = deniedAcl('apply')
      assert.equal(denied.Attributes, -1, 'Access denial must come from actual GetFileAttributesW')
      assert.equal(denied.Error, 5, 'Access denial must report actual ERROR_ACCESS_DENIED')
      assert.equal(denied.PathNormalizationStable, true)
      assert.deepEqual(denied.Paths, expectedDeniedPaths)
      assert.deepEqual(
        denied.NativeBaseline,
        preparedAcl.After,
        'Denial must observe the exact explicitly prepared native baseline',
      )
      const savedAcl = JSON.parse(fs.readFileSync(deniedBackup, 'utf8'))
      assert.equal(savedAcl.ParentAccess, preparedAcl.After.ParentAccess)
      assert.equal(savedAcl.FileAccess, preparedAcl.After.FileAccess)
      assert.deepEqual(savedAcl.NativeBaseline, preparedAcl.After)
      const afterDeniedPaths = deniedAcl('probe-path', {}, true, 'paths-under-actual-denial')
      assert.deepEqual(
        afterDeniedPaths,
        beforeDeniedPaths,
        'Actual access denial must preserve the same native-normalized owned paths',
      )
      execute('guard-native-access-denied', 'guard', deniedTarget, 0)
      execute('required-native-access-denied', 'required', deniedTarget, 0)
      execute('exact-native-access-denied', 'exact', deniedTarget, 0)
      execute('preflight-native-access-denied', 'preflight', deniedTarget, 0)
      hashRejected('native-access-denied', deniedFile)
      rawLaunch('native-access-denied', rawDecoder, deniedFile, 'unavailable')
      assert.deepEqual(
        execute('extract-native-access-denied', 'extract', deniedTarget, 0, good, false),
        [],
        'A native access-denied expected path must be rejected before extraction or copying',
      )
      assert.deepEqual(
        inventory(fileSymlinkOutside),
        deniedOutsideBefore,
        'Native access-denied rejection must preserve every outside hash',
      )
      console.log(
        `Native access-denied proof: GetFileAttributesW=-1, GetLastError=5 for expected nested payload; ordinary root guard retained stock eligibility, preflight rejected, extraction exited before writes for SID ${denied.Sid}.`,
      )
    } catch (error) {
      deniedPrimaryFailure = error
    } finally {
      finishFixtureCleanup(
        deniedPrimaryFailure,
        () => {
          if (fs.existsSync(deniedBackup)) {
            const restored = deniedAcl('restore')
            assert.equal(restored.Restored, true)
            assert.equal(restored.PathNormalizationStable, true)
            assert.deepEqual(restored.Paths, expectedDeniedPaths)
            assert.deepEqual(
              restored.NativeRestored,
              preparedAcl.After,
              'Restoration must preserve exact native control flags, ordered DACL bytes and every baseline field',
            )
            assert.deepEqual(restored.DirectoryEntries, deniedParentEntries)
            assert.equal(restored.FileLength, deniedFileLength)
            assert.equal(restored.FileSha256, deniedFileHash)
            assert.equal(restored.ParentAttributes & 0x410, 0x10)
          }
        },
        'owned fixture ACL restoration',
      )
    }
    assert.deepEqual(
      inventory(deniedTarget),
      deniedBefore,
      'Native access-denied rejection and DACL restoration must preserve the entire payload',
    )

    const direct = directory('extract-direct')
    const directPhases = execute('extract-direct', 'extract', direct, 1)
    assert.deepEqual(
      directPhases,
      [
        'payload-direct-start',
        'extract-start',
        'modern-decoder-start',
        'modern-decoder-result-ok',
        'extract-complete',
        'payload-verification-start',
        'payload-verification-complete',
        'payload-direct-complete',
        'payload-complete',
        'installer-success',
      ],
      'Direct extraction must verify before successful completion in the real installer',
    )
    assert.ok(
      directPhases.includes('payload-direct-start') &&
        directPhases.includes('payload-direct-complete'),
    )
    assert.equal(
      directPhases.includes('payload-copy-start'),
      false,
      'Empty targets must bypass payload copying',
    )
    assert.deepEqual(
      inventory(direct),
      inventory(payload),
      'Direct extraction must install the exact trusted tree',
    )
    const wrongPin = directory('extract-wrong-modern-pin')
    const wrongPinPhases = execute('extract-wrong-modern-pin', 'extract-wrong-pin', wrongPin, 1)
    assert.ok(wrongPinPhases.includes('modern-decoder-result-error'))
    assert.equal(
      wrongPinPhases.includes('modern-decoder-start'),
      false,
      'A wrong decoder pin must fail before CreateProcess',
    )
    assert.ok(wrongPinPhases.includes('payload-direct-fallback'))
    assert.deepEqual(
      inventory(wrongPin),
      inventory(payload),
      'Wrong decoder pin recovery must still verify every trusted payload hash',
    )
    const collisionTarget = directory('extract-trusted-guard-collision')
    const collisionPhases = execute(
      'extract-trusted-guard-collision',
      'extract',
      collisionTarget,
      1,
      collisionArchive,
      true,
      collisionExecutable,
    )
    assert.ok(collisionPhases.includes('modern-decoder-start'))
    assert.ok(
      collisionPhases.includes('modern-decoder-result-error'),
      'The decoder must reject overwriting the held CREATE_NEW guard',
    )
    assert.equal(collisionPhases.includes('modern-decoder-result-ok'), false)
    assert.ok(
      collisionPhases.includes('payload-direct-fallback') &&
        collisionPhases.includes('payload-copy-complete'),
    )
    assert.deepEqual(
      inventory(collisionTarget),
      inventory(collisionPayload),
      'After guard removal the exact verified stock stage must install the legitimate trusted collision file',
    )
    assert.equal(
      fs.readFileSync(path.join(collisionTarget, '.life-installer-extractor-guard'), 'utf8'),
      collisionText,
    )
    const staged = directory('extract-staged')
    fs.writeFileSync(path.join(staged, 'payload.bin'), 'Old payload\n')
    const stagedPhases = execute('extract-staged', 'extract', staged, 1)
    assert.deepEqual(
      stagedPhases,
      [
        'extract-start',
        'payload-verification-start',
        'payload-verification-complete',
        'extract-complete',
        'payload-copy-start',
        'payload-copy-complete',
        'payload-verification-start',
        'payload-verification-complete',
        'payload-complete',
        'installer-success',
      ],
      'Stock extraction must verify both its exact stage and final required files',
    )
    assert.equal(
      stagedPhases.includes('payload-direct-start'),
      false,
      'Nonempty targets must retain stock extraction',
    )
    assert.ok(
      stagedPhases.includes('payload-copy-start') && stagedPhases.includes('payload-copy-complete'),
    )
    assert.deepEqual(
      inventory(staged),
      inventory(payload),
      'Stock extraction must replace required payload files',
    )
    const retained = directory('extract-retained-extras')
    fs.writeFileSync(path.join(retained, 'unrelated.txt'), 'Retain unrelated data\n')
    fs.mkdirSync(path.join(retained, 'unrelated-directory'))
    const unrelatedOutside = directory('unrelated-junction-destination')
    fs.writeFileSync(
      path.join(unrelatedOutside, 'sentinel.txt'),
      'Outside unrelated link remains intact\n',
    )
    const unrelatedBefore = inventory(unrelatedOutside)
    fs.symlinkSync(unrelatedOutside, path.join(retained, 'unrelated-junction'), 'junction')
    execute('extract-retained-extras', 'extract', retained, 1)
    assert.equal(
      fs.readFileSync(path.join(retained, 'unrelated.txt'), 'utf8'),
      'Retain unrelated data\n',
    )
    assert.ok(fs.statSync(path.join(retained, 'unrelated-directory')).isDirectory())
    assert.ok(fs.lstatSync(path.join(retained, 'unrelated-junction')).isSymbolicLink())
    assert.deepEqual(
      inventory(unrelatedOutside),
      unrelatedBefore,
      'Stock copy must not traverse unrelated links',
    )
    execute('required-retained-extras', 'required', retained, 1)
    execute('exact-retained-extras', 'exact', retained, 0)
    const outsidePayload = directory('extract-outside-payload', true)
    const outsideBefore = inventory(outsidePayload)
    const extractRootJunction = path.join(scratch, 'extract-root-junction')
    fs.symlinkSync(outsidePayload, extractRootJunction, 'junction')
    assert.deepEqual(
      execute('extract-root-junction', 'extract', extractRootJunction, 0, good, false),
      [],
      'Root junction must be rejected before extraction or copying',
    )
    assert.deepEqual(
      inventory(outsidePayload),
      outsideBefore,
      'Rejected root junction must not change its destination',
    )
    const outsideAncestor = directory('extract-outside-ancestor')
    fs.mkdirSync(path.join(outsideAncestor, 'child'))
    fs.writeFileSync(
      path.join(outsideAncestor, 'sentinel.txt'),
      'Outside ancestor remains intact\n',
    )
    const outsideAncestorBefore = inventory(outsideAncestor)
    const extractAncestorJunction = path.join(scratch, 'extract-ancestor-junction')
    fs.symlinkSync(outsideAncestor, extractAncestorJunction, 'junction')
    assert.deepEqual(
      execute(
        'extract-ancestor-junction',
        'extract',
        path.join(extractAncestorJunction, 'child'),
        0,
        good,
        false,
      ),
      [],
      'Junction ancestor must be rejected before extraction or copying',
    )
    assert.deepEqual(
      inventory(outsideAncestor),
      outsideAncestorBefore,
      'Rejected junction ancestor must not change its destination',
    )
    const extractNested = directory('extract-nested-junction')
    fs.symlinkSync(
      path.join(outsidePayload, 'nested'),
      path.join(extractNested, 'nested'),
      'junction',
    )
    assert.deepEqual(
      execute('extract-nested-junction', 'extract', extractNested, 0, good, false),
      [],
      'Expected-directory junction must be rejected before extraction or copying',
    )
    assert.deepEqual(
      inventory(outsidePayload),
      outsideBefore,
      'Rejected expected-directory junction must not change its destination',
    )
    for (const [name, filename] of [
      ['crc', corrupt],
      ['truncated', truncated],
      ['short-valid-crc', short],
    ]) {
      const target = directory(`extract-invalid-${name}`)
      const phases = execute(`extract-invalid-${name}`, 'extract', target, 0, filename, false)
      assert.ok(
        phases.includes('payload-direct-fallback'),
        `${name}: direct failure must enter the verified stock fallback`,
      )
      assert.equal(
        phases.includes('payload-complete'),
        false,
        `${name}: unverified payload must never complete`,
      )
    }
    const locked = directory('extract-locked')
    fs.writeFileSync(path.join(locked, 'payload.bin'), 'Locked old payload\n')
    const lockedPhases = execute('extract-locked', 'extract-locked', locked, 0, good, false)
    assert.equal(fs.readFileSync(path.join(locked, 'payload.bin'), 'utf8'), 'Locked old payload\n')
    assert.ok(
      lockedPhases.includes('extract-fallback-start'),
      'Busy output must retain the stock retry/fallback path',
    )
    assert.equal(
      lockedPhases.includes('payload-complete'),
      false,
      'Busy output must not bypass installed-payload verification',
    )

    const interrupted = directory('extract-interrupted')
    const appData = directory('interruption-appdata')
    const roamingAppData = path.join(appData, 'Roaming')
    const localAppData = path.join(appData, 'Local')
    fs.mkdirSync(roamingAppData)
    fs.mkdirSync(localAppData)
    const redirectedAppData = { APPDATA: roamingAppData, LOCALAPPDATA: localAppData }
    const beforeFirstStock = inventory(appData)
    assert.deepEqual(beforeFirstStock, [
      { name: 'Local', directory: true },
      { name: 'Roaming', directory: true },
    ])
    const firstStockTarget = directory('appdata-stock-prime-one')
    execute(
      'appdata-stock-prime-one',
      'extract',
      firstStockTarget,
      1,
      good,
      true,
      controlExecutable,
      redirectedAppData,
    )
    assert.deepEqual(inventory(firstStockTarget), inventory(payload))
    const afterFirstStock = inventory(appData)
    console.log(
      `Unchanged stock first AppData initialization: ${JSON.stringify({ beforeFirstStock, afterFirstStock })}`,
    )
    assert.deepEqual(
      afterFirstStock,
      [
        'Local',
        'Local/Microsoft',
        'Local/Microsoft/Windows',
        'Local/Microsoft/Windows/Caches',
        'Roaming',
      ].map((name) => ({ name, directory: true })),
      'Unchanged stock installer must establish exactly the observed Windows AppData scaffold',
    )
    const beforeSecondStock = inventory(appData)
    assert.deepEqual(beforeSecondStock, afterFirstStock)
    const secondStockTarget = directory('appdata-stock-prime-two')
    execute(
      'appdata-stock-prime-two',
      'extract',
      secondStockTarget,
      1,
      good,
      true,
      controlExecutable,
      redirectedAppData,
    )
    assert.deepEqual(inventory(secondStockTarget), inventory(payload))
    const afterSecondStock = inventory(appData)
    console.log(
      `Unchanged stock repeat AppData initialization: ${JSON.stringify({ beforeSecondStock, afterSecondStock })}`,
    )
    assert.deepEqual(
      afterSecondStock,
      beforeSecondStock,
      'A repeat unchanged stock installer must leave the complete redirected AppData inventory stable',
    )
    fs.writeFileSync(path.join(roamingAppData, 'preferences.json'), '{"retained":true}\n')
    fs.writeFileSync(path.join(roamingAppData, 'sessions.json'), '["retained-session"]\n')
    fs.writeFileSync(path.join(localAppData, 'notes.txt'), 'Retain AppData through interruption\n')
    const appDataBefore = inventory(appData)
    const interruptionOutsideBefore = inventory(outsidePayload)
    const interruptionReport = path.join(observerControls, 'interruption.result')
    const interruptionTrace = path.join(observerControls, 'interruption.trace.tsv')
    const legacyInterrupted = directory('extract-legacy-interrupted')
    const legacyInterruptionReport = path.join(scratch, 'legacy-interruption.result')
    const legacyInterruptionTrace = path.join(scratch, 'legacy-interruption.trace.tsv')
    const legacyInterruption = await interruptActualExtraction({
      executable: legacyLargeExecutable,
      env: {
        ...process.env,
        TEMP: nativeTemp,
        TMP: nativeTemp,
        ...redirectedAppData,
        LIFE_NSIS_PAYLOAD_FIXTURE_MODE: 'extract',
        LIFE_NSIS_PAYLOAD_FIXTURE_TARGET: legacyInterrupted,
        LIFE_NSIS_PAYLOAD_FIXTURE_EXPECTED: '1',
        LIFE_NSIS_PAYLOAD_FIXTURE_RESULT: legacyInterruptionReport,
        LIFE_NSIS_PAYLOAD_FIXTURE_ARCHIVE: largeArchive,
        LIFE_NSIS_TRACE_FILE: legacyInterruptionTrace,
      },
      target: legacyInterrupted,
      report: legacyInterruptionReport,
      trace: legacyInterruptionTrace,
      expectedSize: largeBytes.length,
      expectedPrefix: largeBytes.subarray(0, 4096),
      expectedTail: largeBytes.subarray(largeBytes.length - 4096),
      expectedSha256: sha256(path.join(largePayload, 'large.bin')),
    })
    const legacyAppDataAfterInterruption = inventory(appData)
    console.log(
      `Seeded AppData legacy interruption preservation: ${JSON.stringify({ appDataBefore, legacyAppDataAfterInterruption })}`,
    )
    assert.deepEqual(
      legacyAppDataAfterInterruption,
      appDataBefore,
      'Original legacy interruption must preserve every seeded AppData hash',
    )
    assert.deepEqual(inventory(outsidePayload), interruptionOutsideBefore)
    assert.deepEqual(
      execute(
        'extract-legacy-interrupted-retry',
        'extract',
        legacyInterrupted,
        1,
        largeArchive,
        true,
        legacyLargeExecutable,
        redirectedAppData,
      ),
      stagedPhases,
    )
    assert.deepEqual(
      inventory(legacyInterrupted),
      inventory(largePayload),
      'Original legacy reinstall must restore every trusted hash',
    )
    const legacyAppDataAfterRecovery = inventory(appData)
    console.log(
      `Seeded AppData legacy recovery preservation: ${JSON.stringify({ appDataBefore, legacyAppDataAfterRecovery })}`,
    )
    assert.deepEqual(legacyAppDataAfterRecovery, appDataBefore)
    assert.deepEqual(inventory(outsidePayload), interruptionOutsideBefore)
    console.log(
      `Original legacy interruption proof retained: ${JSON.stringify(legacyInterruption)}`,
    )
    assertControlIsolation(nativeTemp, largeArchive, interrupted)
    const modernObserverConfig = {
      ...observerConfig(
        'modern-interruption',
        largeExecutable,
        nativeTemp,
        'life-modern-decoder\\7za-26.04-x64.exe',
        'PartialKill',
        interruptionReport,
      ),
      PayloadFile: path.join(interrupted, 'large.bin'),
      ExpectedSize: largeBytes.length,
      PrefixBase64: largeBytes.subarray(0, 4096).toString('base64'),
      TailBase64: largeBytes.subarray(largeBytes.length - 4096).toString('base64'),
    }
    const modernObserver = await startDecoderObserver({
      scratch,
      name: 'modern-interruption',
      source: modern.observerSource,
      config: modernObserverConfig,
      env: { ...process.env, TEMP: nativeTemp, TMP: nativeTemp, ...redirectedAppData },
    })
    const interruption = await interruptActualExtraction({
      executable: largeExecutable,
      env: {
        ...process.env,
        TEMP: nativeTemp,
        TMP: nativeTemp,
        ...redirectedAppData,
        LIFE_NSIS_PAYLOAD_FIXTURE_MODE: 'extract',
        LIFE_NSIS_PAYLOAD_FIXTURE_TARGET: interrupted,
        LIFE_NSIS_PAYLOAD_FIXTURE_EXPECTED: '1',
        LIFE_NSIS_PAYLOAD_FIXTURE_RESULT: interruptionReport,
        LIFE_NSIS_PAYLOAD_FIXTURE_ARCHIVE: largeArchive,
        LIFE_NSIS_TRACE_FILE: interruptionTrace,
      },
      target: interrupted,
      report: interruptionReport,
      trace: interruptionTrace,
      expectedSize: largeBytes.length,
      expectedPrefix: largeBytes.subarray(0, 4096),
      expectedTail: largeBytes.subarray(largeBytes.length - 4096),
      expectedSha256: sha256(path.join(largePayload, 'large.bin')),
      observer: modernObserver,
    })
    const appDataAfterInterruption = inventory(appData)
    console.log(
      `Seeded AppData interruption preservation: ${JSON.stringify({ appDataBefore, appDataAfterInterruption })}`,
    )
    assert.deepEqual(
      appDataAfterInterruption,
      appDataBefore,
      'The interrupted installer must preserve the entire seeded AppData inventory before recovery',
    )
    execute('guard-interrupted', 'guard', interrupted, 0)
    const recoveredPhases = execute(
      'extract-interrupted-retry',
      'extract',
      interrupted,
      1,
      largeArchive,
      true,
      largeExecutable,
      redirectedAppData,
    )
    assert.equal(
      recoveredPhases.includes('payload-direct-start'),
      false,
      'A genuinely partial target must retain stock staging and copying on retry',
    )
    assert.deepEqual(
      recoveredPhases,
      stagedPhases,
      'Interrupted reinstall must verify the stock stage and final required payload',
    )
    assert.deepEqual(
      inventory(interrupted),
      inventory(largePayload),
      'Reinstall must completely repair the interrupted payload',
    )
    const appDataAfterRecovery = inventory(appData)
    console.log(
      `Seeded AppData recovery preservation: ${JSON.stringify({ appDataBefore, appDataAfterRecovery })}`,
    )
    assert.deepEqual(
      appDataAfterRecovery,
      appDataBefore,
      'Interruption and reinstall must preserve the entire seeded AppData inventory and hashes',
    )
    assert.deepEqual(
      inventory(outsidePayload),
      interruptionOutsideBefore,
      'Interruption and reinstall must preserve outside fixture hashes',
    )
    console.log(
      `Modern native interruption proof: ${JSON.stringify(interruption)}; exact NSIS and decoder handles signaled before complete stable inventory/hash checks, and stock reinstall restored every trusted hash.`,
    )
    console.log(
      `Real Windows NSIS payload fixture passed ${trials} trials plus independent legacy and modern in-progress interruptions: full hashes and exact inventory, all 20 registers, stack, set/clear errors, handle preservation, file-symlink/native-access-denied rejection, reparse/compressed guard, unchanged stock metadata parity, custom ACL/ADS preservation, modern raw protocol and private fault/descendant containment, actual attribute-only junction mutation rejection, trusted guard-filename collision recovery, direct and stock extraction, CRC/truncated/short archives, retained extras, busy-file fail-closed behavior, stock-initialized AppData equality and verified interruption recovery.`,
    )
  } catch (error) {
    primaryFailure = error
  } finally {
    finishFixtureCleanup(
      primaryFailure,
      () => fs.rmSync(scratch, { recursive: true, force: true }),
      'owned fixture scratch cleanup',
    )
  }
}

main().catch((error) => {
  reportFixtureFailure(error)
  process.exitCode = 1
})
