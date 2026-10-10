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
$fixtureRoot = [IO.Path]::GetFullPath($env:LIFE_ACL_FIXTURE_ROOT).TrimEnd([char]'\')
$fixtureFile = [IO.Path]::GetFullPath($env:LIFE_ACL_FIXTURE_FILE)
$fixtureParent = [IO.Path]::GetDirectoryName($fixtureFile)
$scratchRoot = [IO.Path]::GetFullPath($env:LIFE_ACL_FIXTURE_SCRATCH).TrimEnd([char]'\')
if (-not $fixtureRoot.StartsWith(($scratchRoot + '\'), [StringComparison]::OrdinalIgnoreCase) -or -not $fixtureFile.StartsWith(($fixtureRoot + '\'), [StringComparison]::OrdinalIgnoreCase) -or $fixtureParent.Equals($fixtureRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Access denial must be confined to a nested, fixture-owned payload path.' }
$sections = [Security.AccessControl.AccessControlSections]::Access
$identitySections = [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;
public static class LifeFixtureAttributes {
  public sealed class Result { public long Attributes; public int Error; }
  public sealed class FileRead { public long Length; public string Sha256; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  private static extern uint GetFileAttributesW(string path);
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
  [DllImport("kernel32.dll", ExactSpelling=true, SetLastError=true)]
  private static extern IntPtr LocalFree(IntPtr memory);
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
if ($env:LIFE_ACL_FIXTURE_ACTION -eq 'apply') {
  foreach ($ordinary in @($fixtureRoot, $fixtureParent)) {
    $attributes = [LifeFixtureAttributes]::Read($ordinary)
    if ($attributes.Attributes -eq -1 -or ($attributes.Attributes -band 0x10) -eq 0 -or ($attributes.Attributes -band 0x400) -ne 0) { throw 'Access denial requires ordinary fixture directories.' }
  }
  $beforeFile = [LifeFixtureAttributes]::Read($fixtureFile)
  $beforeParent = [LifeFixtureAttributes]::Read($fixtureParent)
  if ($beforeFile.Attributes -eq -1 -or ($beforeFile.Attributes -band 0x410) -ne 0) { throw 'Access denial requires an ordinary expected file.' }
  $parentAcl = [IO.Directory]::GetAccessControl($fixtureParent)
  $fileAcl = [IO.File]::GetAccessControl($fixtureFile)
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
  }
  [LifeFixtureAttributes]::ValidateAccess($backup.ParentAccess)
  [LifeFixtureAttributes]::ValidateAccess($backup.FileAccess)
  [IO.File]::WriteAllText($env:LIFE_ACL_FIXTURE_BACKUP, (ConvertTo-Json -InputObject $backup -Compress), [Text.UTF8Encoding]::new($false))
  # NTFS also exposes a child's attributes through parent directory listing.
  # Deny both independent rights, without denying traversal or WRITE_DAC.
  $parentAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($currentSid, [Security.AccessControl.FileSystemRights]::ListDirectory, [Security.AccessControl.InheritanceFlags]::None, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Deny))
  $fileAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($currentSid, [Security.AccessControl.FileSystemRights]::ReadAttributes, [Security.AccessControl.InheritanceFlags]::None, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Deny))
  [IO.File]::SetAccessControl($fixtureFile, $fileAcl)
  [IO.Directory]::SetAccessControl($fixtureParent, $parentAcl)
  $denied = [LifeFixtureAttributes]::Read($fixtureFile)
  if ($denied.Attributes -ne -1 -or $denied.Error -ne 5) { throw ('Expected actual native GetFileAttributesW access denial, got attributes=' + $denied.Attributes + ', error=' + $denied.Error) }
  $result = [PSCustomObject]@{ Attributes = $denied.Attributes; Error = $denied.Error; Sid = $currentSid.Value }
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
  $result = [PSCustomObject]@{ Restored = $true; Attributes = $restoredAttributes.Attributes; ParentAttributes = $restoredParentAttributes.Attributes; Sid = $currentSid.Value; DirectoryEntries = $restoredEntries; FileLength = $restoredRead.Length; FileSha256 = $restoredRead.Sha256 }
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
        started = logged.includes('payload-direct-start') && logged.includes('extract-start')
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
          if (
            prefixRead === prefix.length &&
            prefix.equals(expectedPrefix) &&
            tailRead === tail.length &&
            tail.every((byte) => byte === 0)
          ) {
            observed = {
              pid: child.pid,
              size: fs.fstatSync(fd).size,
              elapsedMs: 30000 - (deadline - performance.now()),
            }
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
    const exit = await bounded(completion, 10000, 'Killed native extractor did not exit')
    if (exit.error) throw exit.error
    assert.ok(exit.code !== 0 || exit.signal, 'Interrupted fixture cannot report successful exit')
    // Close our read handle before retrying the unchanged normal wrapper.
    fs.closeSync(fd)
    fd = undefined
    const after = fs.readFileSync(output)
    assert.equal(
      after.length,
      expectedSize,
      'Preallocated file length must survive the interruption',
    )
    assert.ok(
      after.subarray(0, expectedPrefix.length).equals(expectedPrefix),
      'Written prefix must survive interruption',
    )
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
      ['payload-direct-start', 'extract-start'],
      'Interrupted extraction cannot reach verification, completion, registration or launch',
    )
    for (const item of [report, `${report}.registered`, `${report}.launched`]) {
      assert.equal(
        fs.existsSync(item),
        false,
        'Interrupted extraction cannot produce successful action sentinels',
      )
    }
    return { ...observed, exit, finalSize: after.length, phases: logged }
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    if (!exited) {
      child.kill('SIGKILL')
      await bounded(completion, 10000, 'Failed interrupted trial left a live fixture process')
    }
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
      .map((register, i) => `StrCmp ${register} "register-${i}" 0 fixture_failed`)
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

!macro FixtureBegin
  ${initialize}
  Push "stack-bottom"
  Push "stack-top"
!macroend

!macro FixtureCheck
  StrCmp $fixtureResult $fixtureExpected 0 fixture_failed
  Pop $fixtureScratch
  StrCmp $fixtureScratch "stack-top" 0 fixture_failed
  Pop $fixtureScratch
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

Section
  InitPluginsDir
  ReadEnvStr $fixtureMode "LIFE_NSIS_PAYLOAD_FIXTURE_MODE"
  ReadEnvStr $INSTDIR "LIFE_NSIS_PAYLOAD_FIXTURE_TARGET"
  ReadEnvStr $fixtureExpected "LIFE_NSIS_PAYLOAD_FIXTURE_EXPECTED"
  ReadEnvStr $fixtureReport "LIFE_NSIS_PAYLOAD_FIXTURE_RESULT"
  ReadEnvStr $fixtureArchive "LIFE_NSIS_PAYLOAD_FIXTURE_ARCHIVE"
  StrCpy $packageArch "64"
  ; Warm persistent plug-in loads before checking for enumeration/hash handle leaks.
  ${'${GetProcessInfo}'} 0 $pid $1 $2 $3 $4
  ${'${StdUtils.HashFile}'} $fixtureScratch "SHA2-256" "$fixtureArchive"
  System::Call 'kernel32::GetCurrentProcess() p .r0'
  System::Call 'kernel32::GetProcessHandleCount(p r0, *i .r1) i .r2'
  StrCmp $2 "0" fixture_failed
  StrCpy $fixtureHandleCount $1

  StrCmp $fixtureMode "guard" fixture_guard
  StrCmp $fixtureMode "required" fixture_required
  StrCmp $fixtureMode "exact" fixture_exact
  StrCmp $fixtureMode "preflight" fixture_preflight
  StrCmp $fixtureMode "extract" fixture_extract
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

  fixture_extract_locked:
    System::Call 'kernel32::CreateFileW(w "$INSTDIR\payload.bin", i 0x80000000, i 0, p 0, i 3, i 0, p 0) p .r0'
    StrCmp $0 "-1" fixture_failed
    StrCpy $fixtureLock $0
  fixture_extract:
    SetOutPath "$INSTDIR"
    System::Call 'kernel32::GetCurrentProcessId() i .r0'
    FileOpen $fixtureHandle "$fixtureReport.pid" w
    IfErrors fixture_failed
    FileWrite $fixtureHandle "$0$\r$\n"
    FileClose $fixtureHandle
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
    System::Call 'kernel32::GetCurrentProcess() p .r0'
    System::Call 'kernel32::GetProcessHandleCount(p r0, *i .r1) i .r2'
    StrCmp $2 "0" fixture_failed
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
    if (process.platform !== 'win32') {
      console.log(
        'Real NSIS payload, unchanged stock-control and large-interruption fixtures compiled; CRC and truncated archives rejected. Native runtime assertions require Windows.',
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
      if (succeeds) {
        assert.equal(
          result.status,
          0,
          `${name}: native assertions failed (${result.status})\n${result.stdout}\n${result.stderr}`,
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
    function deniedAcl(action) {
      const output = path.join(scratch, `native-access-denied.${action}.json`)
      const child = requireSuccess(
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
          }),
        },
      )
      if (child.stderr.trim()) console.log(child.stderr.trim())
      return JSON.parse(fs.readFileSync(output, 'utf8'))
    }
    let deniedPrimaryFailure
    try {
      const denied = deniedAcl('apply')
      assert.equal(denied.Attributes, -1, 'Access denial must come from actual GetFileAttributesW')
      assert.equal(denied.Error, 5, 'Access denial must report actual ERROR_ACCESS_DENIED')
      execute('guard-native-access-denied', 'guard', deniedTarget, 0)
      execute('required-native-access-denied', 'required', deniedTarget, 0)
      execute('exact-native-access-denied', 'exact', deniedTarget, 0)
      execute('preflight-native-access-denied', 'preflight', deniedTarget, 0)
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
    const interruptionReport = path.join(scratch, 'interruption.result')
    const interruptionTrace = path.join(scratch, 'interruption.trace.tsv')
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
      `Native interruption proof: actual extractor PID ${interruption.pid}, preallocated ${interruption.finalSize} bytes, written prefix and unwritten tail observed before kill and retained after process exit; stock reinstall restored every trusted hash.`,
    )
    console.log(
      `Real Windows NSIS payload fixture passed ${trials} trials plus actual in-progress interruption: full hashes and exact inventory, all 20 registers, stack, set/clear errors, handle preservation, file-symlink/native-access-denied rejection, reparse/compressed guard, unchanged stock metadata parity, custom ACL/ADS preservation, direct and stock extraction, CRC/truncated/short archives, retained extras, busy-file fail-closed behavior, stock-initialized AppData equality and verified interruption recovery.`,
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
