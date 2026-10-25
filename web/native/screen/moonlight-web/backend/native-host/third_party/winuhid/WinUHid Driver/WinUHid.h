#pragma once

#include <windows.h>
#include <wdf.h>
#include <initguid.h>

#include <vhf.h>

#include "Trace.h"
#include "Public.h"

EXTERN_C_START

#ifdef MOONLIGHTWEB_VHID
//
// MoonlightWeb: the engine's descriptor check (drivers/vhid/DescriptorCheck.cpp)
//
int MwHidDescriptorAllowed(const unsigned char* data, unsigned long size);
#endif

#define INSTANCE_ID_TAG 'iHUW'
#define REPORT_DESC_TAG 'rHUW'
#define HARDWARE_IDS_TAG 'hHUW'
#define WRITE_BUFFER_TAG 'wHUW'

typedef struct _DEVICE_CONTEXT
{
    WDFDEVICE Device;
    WDFQUEUE GetNextEventIoctlQueue;
} DEVICE_CONTEXT, *PDEVICE_CONTEXT;
WDF_DECLARE_CONTEXT_TYPE_WITH_NAME(DEVICE_CONTEXT, DeviceGetContext)

typedef struct _HID_REPORT_SIZE
{
    ULONG InputReportSize;
    ULONG OutputReportSize;
    ULONG FeatureReportSize;
} HID_REPORT_SIZE, *PHID_REPORT_SIZE;

typedef struct _FILE_CONTEXT
{
    PDEVICE_CONTEXT DeviceContext;
    WDFFILEOBJECT FileObject;

    //
    // I/O target of the next lower device object (VHF)
    //
    WDFIOTARGET VhfIoTarget;

    //
    // Device info set via setup IOCTLs
    //
    BOOLEAN DeviceInfoSet;
    VHF_CONFIG VhfConfig;
    WDFMEMORY InstanceIdMem;
    WDFMEMORY ReportDescriptorMem;
    WDFMEMORY HardwareIdsMem;

    //
    // HID report sizes
    //
    HID_REPORT_SIZE ReportSizes[256];
    BOOLEAN NumberedReports;

    //
    // Counter used for assigning request handles
    //
    LONG NextRequestId;

    //
    // VHF handle of the child device (if created)
    //
    VHFHANDLE VhfHandle;

    //
    // Synchronizes the collections below. We use a separate lock rather than the
    // built-in wait lock in the WDF collections because we need to synchronize
    // them against each other too.
    //
    WDFWAITLOCK RequestLock;

    //
    // Requests in this collection have yet to be consumed by IOCTL_WINUHID_GET_NEXT_EVENT
    //
    WDFCOLLECTION WaitingRequests;

    //
    // Requests in this collection have been returned to the user via IOCTL_WINUHID_GET_NEXT_EVENT,
    // but not yet completed via IOCTL_WINUHID_COMPLETE_WRITE_EVENT or IOCTL_WINUHID_COMPLETE_READ_EVENT.
    //
    WDFCOLLECTION OutstandingRequests;
} FILE_CONTEXT, *PFILE_CONTEXT;
WDF_DECLARE_CONTEXT_TYPE_WITH_NAME(FILE_CONTEXT, FileGetContext)

typedef struct _OPERATION_CONTEXT
{
    WINUHID_EVENT_TYPE Type;
    WINUHID_REQUEST_ID RequestId;
    VHFOPERATIONHANDLE Handle;

    //
    // The HID_XFER_PACKET will go out of scope when we return from the
    // callback function. We shallow-copy to preserve it.
    //
    HID_XFER_PACKET HidTransferPacket;
} OPERATION_CONTEXT, *POPERATION_CONTEXT;
WDF_DECLARE_CONTEXT_TYPE_WITH_NAME(OPERATION_CONTEXT, OpGetContext)

EXTERN_C_END
