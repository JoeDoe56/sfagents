#pragma once

//
// Define the tracing flags.
//
// Tracing GUID - 0e97c6bb-41e8-4c46-bf39-0815d1f90ea9
//

// MoonlightWeb: a tracing GUID of our own, 8c1f6b0e-3d52-4a77-9e1b-5a2f0c6d7e41
// (upstream's is 0e97c6bb-41e8-4c46-bf39-0815d1f90ea9). Written out: tracewpp
// reads it as text.
#define WPP_CONTROL_GUIDS                                              \
    WPP_DEFINE_CONTROL_GUID(                                           \
        WinUHidTraceGuid, (8c1f6b0e,3d52,4a77,9e1b,5a2f0c6d7e41),      \
                                                                       \
        WPP_DEFINE_BIT(TRACE_DRIVER)                                   \
        WPP_DEFINE_BIT(TRACE_DEVICE)                                   \
        WPP_DEFINE_BIT(TRACE_EVENT)                                    \
        WPP_DEFINE_BIT(TRACE_PARSING)                                  \
        )

#define WPP_FLAG_LEVEL_LOGGER(flag, level)                             \
    WPP_LEVEL_LOGGER(flag)

#define WPP_FLAG_LEVEL_ENABLED(flag, level)                            \
    (WPP_LEVEL_ENABLED(flag) &&                                        \
     WPP_CONTROL(WPP_BIT_ ## flag).Level >= level)

#define WPP_LEVEL_FLAGS_LOGGER(lvl,flags)                              \
           WPP_LEVEL_LOGGER(flags)

#define WPP_LEVEL_FLAGS_ENABLED(lvl, flags)                            \
           (WPP_LEVEL_ENABLED(flags) && WPP_CONTROL(WPP_BIT_ ## flags).Level >= lvl)

//
// This comment block is scanned by the trace preprocessor to define our
// Trace function.
//
// begin_wpp config
// FUNC TraceEvents(LEVEL, FLAGS, MSG, ...);
// end_wpp

//
//
// Driver specific #defines
//
#if UMDF_VERSION_MAJOR == 2 && UMDF_VERSION_MINOR == 0
    #define MYDRIVER_TRACING_ID      L"Microsoft\\UMDF2.0\\WinUHidDriver V1.0"
#endif