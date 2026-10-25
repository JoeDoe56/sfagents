# ============================================================================
# sfagents-screen: SF Agents' screen mirroring helper.
#
# Built from the parts of MoonlightWeb (https://github.com/linckosz/moonlight-web,
# GPL-3.0-or-later) that stream this computer's own screen: its capture and
# encoding engine (moonlight-web/backend/native-host), and the per-stream
# worker that carries the picture, the sound and the input over WebRTC
# (moonlight-web/backend/src, the files listed below). Nothing that finds,
# pairs with or streams from another host is built: no GameStream, Sunshine,
# Wolf or MultiSeat, no host list, no pairing, no sharing, no internet
# access, no updater, no tray, no HTTP server. SF Agents' own server starts
# one of these per stream and talks to it on stdin/stdout (src/ScreenMain.cpp).
#
# The dependencies are fetched at pinned commits by scripts/build-screen.mjs
# into the places MoonlightWeb's own build expects them (git-ignored).
# ============================================================================

cmake_minimum_required(VERSION 3.21)
project(sfagents-screen VERSION 0.1.0 LANGUAGES C CXX)

set(MW ${CMAKE_CURRENT_SOURCE_DIR}/moonlight-web/backend)
set(MW_VERSION "sfagents-${PROJECT_VERSION}" CACHE STRING "")

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 11)
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
endif()
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# ── OpenSSL (DTLS for WebRTC) ───────────────────────────────────────────────
if(APPLE)
    foreach(_brew_ssl /opt/homebrew/opt/openssl@3 /usr/local/opt/openssl@3)
        if(EXISTS "${_brew_ssl}")
            set(OPENSSL_ROOT_DIR "${_brew_ssl}")
            break()
        endif()
    endforeach()
endif()
find_package(OpenSSL 1.1 REQUIRED)

# ── Qt 6: the worker's event loop, JSON, the signaling WebSocket, the clipboard
find_package(Qt6 REQUIRED COMPONENTS Core Gui Network WebSockets)
set(CMAKE_AUTOMOC ON)
find_package(Threads REQUIRED)

# ── The capture & encoding engine, unchanged ───────────────────────────────
option(MW_BUILD_TESTS "Build MoonlightWeb's native engine tests" OFF)
add_subdirectory(${MW}/native-host native-host)

# ── moonlight-common-c ──────────────────────────────────────────────────────
# TODO(sfagents): only Limelight.h's codec and format constants are wanted;
# MoonlightShim (the GameStream engine) still links it until it is cut out.
add_subdirectory(${MW}/third_party/moonlight-common-c moonlight-common-c EXCLUDE_FROM_ALL)
set(MW_LIMELIGHT_INCLUDE ${MW}/third_party/moonlight-common-c/src ${MW}/third_party/moonlight-common-c/enet/include)

# ── libdatachannel, with MoonlightWeb's patches ────────────────────────────
find_package(Git REQUIRED)
function(mw_apply_patch dir patch)
    set(p "${MW}/third_party/patches/${patch}")
    execute_process(COMMAND "${GIT_EXECUTABLE}" -C "${dir}" apply --reverse --check "${p}"
                    RESULT_VARIABLE applied OUTPUT_QUIET ERROR_QUIET)
    if(applied EQUAL 0)
        return()
    endif()
    execute_process(COMMAND "${GIT_EXECUTABLE}" -C "${dir}" apply "${p}"
                    RESULT_VARIABLE failed ERROR_VARIABLE why)
    if(NOT failed EQUAL 0)
        message(FATAL_ERROR "${patch} does not apply to ${dir}: ${why}")
    endif()
    message(STATUS "applied ${patch}")
endfunction()
set(MW_LDC ${MW}/third_party/libdatachannel)
mw_apply_patch(${MW_LDC} libdatachannel-dscp-settings.patch)
mw_apply_patch(${MW_LDC} libdatachannel-srtp-dscp.patch)
if(WIN32)
    mw_apply_patch(${MW_LDC}/deps/libjuice libjuice-windows-diffserv.patch)
elseif(APPLE)
    mw_apply_patch(${MW_LDC}/deps/libjuice libjuice-macos-diffserv.patch)
endif()
set(NO_WEBSOCKET ON  CACHE BOOL "" FORCE)
set(NO_MEDIA     OFF CACHE BOOL "" FORCE)
set(NO_EXAMPLES  ON  CACHE BOOL "" FORCE)
set(NO_TESTS     ON  CACHE BOOL "" FORCE)
set(LIBSRTP_TEST_APPS OFF CACHE BOOL "" FORCE)
set(USE_GNUTLS   OFF CACHE BOOL "" FORCE)
set(USE_MBEDTLS  OFF CACHE BOOL "" FORCE)
add_subdirectory(${MW_LDC} libdatachannel EXCLUDE_FROM_ALL)

# ── The helper ──────────────────────────────────────────────────────────────
include(${CMAKE_CURRENT_SOURCE_DIR}/sources.cmake)
add_executable(sfagents-screen src/ScreenMain.cpp ${SCREEN_SOURCES})

target_include_directories(sfagents-screen PRIVATE
    ${MW}/src
    ${MW}/native-host/include
    ${MW_LIMELIGHT_INCLUDE}
    ${MW_LDC}/deps/usrsctp/usrsctplib
)
target_compile_definitions(sfagents-screen PRIVATE
    RTC_STATIC
    RTC_ENABLE_WEBSOCKET=0
    RTC_ENABLE_MEDIA=1
    MW_VERSION="${MW_VERSION}"
    MW_SFAGENTS=1
)
target_link_libraries(sfagents-screen PRIVATE
    Qt6::Core Qt6::Gui Qt6::Network Qt6::WebSockets
    mw-native-host
    moonlight-common-c
    LibDataChannel::LibDataChannel
    OpenSSL::SSL OpenSSL::Crypto
    Threads::Threads
)

if(WIN32)
    # A console program: SF Agents starts it hidden and reads its stdout.
    target_link_libraries(sfagents-screen PRIVATE ws2_32 winmm Bcrypt Crypt32 iphlpapi Dbghelp avrt
                                                  wtsapi32 userenv ole32 oleaut32
                                                  setupapi newdev cfgmgr32 advapi32 shell32)
elseif(APPLE)
    target_link_libraries(sfagents-screen PRIVATE
        "-framework Security" "-framework CoreFoundation" "-framework Foundation")
else()
    target_link_libraries(sfagents-screen PRIVATE dl)
endif()
