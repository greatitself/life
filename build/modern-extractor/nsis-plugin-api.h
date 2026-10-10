// Minimal, altered Unicode x86 declarations from NSIS v3.04 pluginapi.h/api.h.
// https://github.com/NSIS-Dev/nsis/tree/v304/Contrib/ExDLL
// https://github.com/NSIS-Dev/nsis/blob/v304/Source/exehead/api.h
// Copyright (C) 1999-2018 Nullsoft and Contributors.
// Licensed under the zlib/libpng license, reproduced from NSIS COPYING:
// This software is provided 'as-is', without any express or implied warranty.
// In no event will the authors be held liable for any damages arising from the
// use of this software.
// Permission is granted to anyone to use this software for any purpose,
// including commercial applications, and to alter it and redistribute it
// freely, subject to the following restrictions:
// 1. The origin of this software must not be misrepresented; you must not claim
// that you wrote the original software. If you use this software in a product,
// an acknowledgment in the product documentation would be appreciated but is
// not required.
// 2. Altered source versions must be plainly marked as such, and must not be
// misrepresented as being the original software.
// 3. This notice may not be removed or altered from any source distribution.
#pragma once

#include <windows.h>
#include <cstddef>

struct NsisStack {
  NsisStack* next;
  wchar_t text[1];
};

// Launch never reads or writes the remaining API fields or the variable array.
// These exact declarations make the ABI and flag preservation explicit.
struct NsisExecFlags {
  int autoclose;
  int all_user_var;
  int exec_error;
  int abort;
  int exec_reboot;
  int reboot_called;
  int deprecated_insttype;
  int plugin_api_version;
  int silent;
  int instdir_error;
  int rtl;
  int errlvl;
  int alter_reg_view;
  int status_update;
};

using NsisPluginCallback = UINT_PTR(__cdecl*)(int);
struct NsisExtraParameters {
  NsisExecFlags* exec_flags;
  int (__stdcall* ExecuteCodeSegment)(int, HWND);
  void (__stdcall* validate_filename)(wchar_t*);
  int (__stdcall* RegisterPluginCallback)(HMODULE, NsisPluginCallback);
};

static_assert(sizeof(void*) == 4, "This plugin must be built for Unicode NSIS x86");
static_assert(sizeof(wchar_t) == 2, "NSIS Unicode uses UTF-16");
static_assert(offsetof(NsisStack, text) == 4 && sizeof(NsisStack) == 8);
static_assert(sizeof(NsisExecFlags) == 56 && offsetof(NsisExecFlags, exec_error) == 8);
static_assert(sizeof(NsisExtraParameters) == 16);
