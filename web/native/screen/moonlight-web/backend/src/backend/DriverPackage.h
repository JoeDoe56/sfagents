/*
 * MoonlightWeb — browser-based Sunshine/GameStream client.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * this program. If not, see <https://www.gnu.org/licenses/>.
 */

#pragma once

// What installing a bundled user-mode driver package takes before SetupAPI
// sees a byte of it, shared by "MoonlightWeb Virtual Display"
// (VirtualDisplayApply) and "MoonlightWeb Virtual HID" (VirtualHidApply):
// every file re-hashed against constants compiled into the exe, and the
// catalog's signer trusted for the duration of the install only.

#include <QString>

#include <cstddef>

#ifdef Q_OS_WIN
#define NOMINMAX
#include <windows.h>
#include <wincrypt.h>
#endif

namespace DriverPackage {

/// One file of a package as it must be found next to the exe.
struct File
{
    const char* name;   ///< file name in the package's directory
    const char* sha256; ///< lowercase hex
};

/// Lowercase hex SHA-256 of a file; empty when it cannot be read.
QString fileSha256(const QString& path);

/// Re-hash @p count files under @p dir against their pins. Empty on success,
/// and then @p infPath and @p catPath name the package's .inf and .cat;
/// otherwise the reason, naming the first file that is missing or differs.
QString checkFiles(const QString& dir, const File* files, std::size_t count, QString* infPath,
                   QString* catPath);

#ifdef Q_OS_WIN

/// The catalog's signer in the machine's stores, for as long as this lives:
/// Trusted Publishers always, Root too for a self-signed signer. Removed again
/// on destruction — unless a public CA's signer was there before us.
struct PublisherTrust
{
    struct Entry
    {
        const wchar_t* storeName = nullptr;
        HCERTSTORE store = nullptr;
        PCCERT_CONTEXT added = nullptr; // the copy to remove when this ends
    };
    Entry publisher{L"TrustedPublisher"};
    Entry root{L"Root"};
    bool preexisting = false;
    const char* logTag = "[driver]";

    PublisherTrust() = default;
    PublisherTrust(const PublisherTrust&) = delete;
    PublisherTrust& operator=(const PublisherTrust&) = delete;
    ~PublisherTrust();
};

/// A user-mode driver package installs without a prompt only when the
/// catalog's signer is a trusted publisher. The signer is pinned by its SHA-1
/// @p thumbprintHex; the certificate itself is taken from inside the catalog
/// (already hashed by the caller), never from anywhere else. Nothing signed by
/// anyone else is ever trusted, and the trust does not outlive @p trust.
///
/// @p selfSigned: the signer is MoonlightWeb's own certificate, which chains
/// to nothing Windows trusts, so it goes in Root as well for the install — and
/// leaves both stores afterwards even when an install that was cut short left
/// it there: no machine keeps it. Once installed, the driver loads without it
/// (bench of 11/10/2026, Secure Boot on).
/// @param logTag prefix of the log lines, e.g. "[vdisplay-apply]".
bool trustCatalogSigner(const QString& catPath, const QString& thumbprintHex, bool selfSigned,
                        const char* logTag, PublisherTrust& trust, QString* error);

#endif

} // namespace DriverPackage
