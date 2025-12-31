
// Matter Protocol Definitions
// This file contains standard definitions for Matter Clusters, Attributes, and Commands.

export interface ClusterDefinition {
    id: number;
    name: string;
    attributes: AttributeDefinition[];
    commands: CommandDefinition[];
}

export interface AttributeDefinition {
    id: number;
    name: string;
    type?: string;
    writable?: boolean;
}

export interface CommandDefinition {
    id: number;
    name: string;
    args?: string[]; // Simplified argument list
}

export const MATTER_DEFINITIONS: Record<number, ClusterDefinition> = {
    // --- General ---
    0x0003: {
        id: 0x0003,
        name: 'Identify',
        attributes: [
            { id: 0x0000, name: 'IdentifyTime', type: 'uint16', writable: true },
            { id: 0x0001, name: 'IdentifyType', type: 'enum8', writable: false }
        ],
        commands: [
            { id: 0x00, name: 'Identify', args: ['IdentifyTime'] },
            { id: 0x40, name: 'TriggerEffect', args: ['EffectIdentifier', 'EffectVariant'] }
        ]
    },
    0x0004: {
        id: 0x0004,
        name: 'Groups',
        attributes: [
            { id: 0x0000, name: 'NameSupport', type: 'bitmap8', writable: false }
        ],
        commands: [
            { id: 0x00, name: 'AddGroup', args: ['GroupId', 'GroupName'] },
            { id: 0x01, name: 'ViewGroup', args: ['GroupId'] },
            { id: 0x02, name: 'GetGroupMembership', args: ['GroupList'] },
            { id: 0x03, name: 'RemoveGroup', args: ['GroupId'] },
            { id: 0x04, name: 'RemoveAllGroups', args: [] },
            { id: 0x05, name: 'AddGroupIfIdentifying', args: ['GroupId', 'GroupName'] }
        ]
    },
    0x0005: {
        id: 0x0005,
        name: 'Scenes',
        attributes: [
            { id: 0x0000, name: 'SceneCount', type: 'uint8', writable: false },
            { id: 0x0001, name: 'CurrentScene', type: 'uint8', writable: false },
            { id: 0x0002, name: 'CurrentGroup', type: 'uint16', writable: false },
            { id: 0x0003, name: 'SceneValid', type: 'boolean', writable: false },
            { id: 0x0004, name: 'NameSupport', type: 'bitmap8', writable: false }
        ],
        commands: [
            { id: 0x00, name: 'AddScene', args: ['GroupId', 'SceneId', 'TransitionTime', 'SceneName', 'ExtensionFieldSets'] },
            { id: 0x01, name: 'ViewScene', args: ['GroupId', 'SceneId'] },
            { id: 0x02, name: 'RemoveScene', args: ['GroupId', 'SceneId'] },
            { id: 0x03, name: 'RemoveAllScenes', args: ['GroupId'] },
            { id: 0x04, name: 'StoreScene', args: ['GroupId', 'SceneId'] },
            { id: 0x05, name: 'RecallScene', args: ['GroupId', 'SceneId', 'TransitionTime'] },
            { id: 0x40, name: 'GetSceneMembership', args: ['GroupId'] }
        ]
    },
    0x0006: {
        id: 0x0006,
        name: 'On/Off',
        attributes: [
            { id: 0x0000, name: 'OnOff', type: 'boolean', writable: false }, // Usually read-only via attribute, write via command
            { id: 0x4000, name: 'GlobalSceneControl', type: 'boolean', writable: true },
            { id: 0x4001, name: 'OnTime', type: 'uint16', writable: true },
            { id: 0x4002, name: 'OffWaitTime', type: 'uint16', writable: true },
            { id: 0x4003, name: 'StartUpOnOff', type: 'enum8', writable: true }
        ],
        commands: [
            { id: 0x00, name: 'Off', args: [] },
            { id: 0x01, name: 'On', args: [] },
            { id: 0x02, name: 'Toggle', args: [] },
            { id: 0x40, name: 'OffWithEffect', args: ['EffectIdentifier', 'EffectVariant'] },
            { id: 0x41, name: 'OnWithRecallGlobalScene', args: [] },
            { id: 0x42, name: 'OnWithTimedOff', args: ['OnOffControl', 'OnTime', 'OffWaitTime'] }
        ]
    },
    0x0008: {
        id: 0x0008,
        name: 'Level Control',
        attributes: [
            { id: 0x0000, name: 'CurrentLevel', type: 'uint8', writable: false },
            { id: 0x0001, name: 'RemainingTime', type: 'uint16', writable: false },
            { id: 0x0002, name: 'MinLevel', type: 'uint8', writable: false },
            { id: 0x0003, name: 'MaxLevel', type: 'uint8', writable: false },
            { id: 0x000F, name: 'Options', type: 'bitmap8', writable: true },
            { id: 0x0010, name: 'OnOffTransitionTime', type: 'uint16', writable: true },
            { id: 0x0011, name: 'OnLevel', type: 'uint8', writable: true },
            { id: 0x4000, name: 'StartUpCurrentLevel', type: 'uint8', writable: true }
        ],
        commands: [
            { id: 0x00, name: 'MoveToLevel', args: ['Level', 'TransitionTime', 'OptionsMask', 'OptionsOverride'] },
            { id: 0x01, name: 'Move', args: ['MoveMode', 'Rate', 'OptionsMask', 'OptionsOverride'] },
            { id: 0x02, name: 'Step', args: ['StepMode', 'StepSize', 'TransitionTime', 'OptionsMask', 'OptionsOverride'] },
            { id: 0x03, name: 'Stop', args: ['OptionsMask', 'OptionsOverride'] },
            { id: 0x04, name: 'MoveToLevelWithOnOff', args: ['Level', 'TransitionTime', 'OptionsMask', 'OptionsOverride'] },
            { id: 0x05, name: 'MoveWithOnOff', args: ['MoveMode', 'Rate', 'OptionsMask', 'OptionsOverride'] },
            { id: 0x06, name: 'StepWithOnOff', args: ['StepMode', 'StepSize', 'TransitionTime', 'OptionsMask', 'OptionsOverride'] },
            { id: 0x07, name: 'StopWithOnOff', args: ['OptionsMask', 'OptionsOverride'] }
        ]
    },
    0x001D: {
        id: 0x001D,
        name: 'Descriptor',
        attributes: [
            { id: 0x0000, name: 'DeviceTypeList', type: 'list', writable: false },
            { id: 0x0001, name: 'ServerList', type: 'list', writable: false },
            { id: 0x0002, name: 'ClientList', type: 'list', writable: false },
            { id: 0x0003, name: 'PartsList', type: 'list', writable: false }
        ],
        commands: []
    },
    0x0028: {
        id: 0x0028,
        name: 'Basic Information',
        attributes: [
            { id: 0x0000, name: 'DataModelRevision', type: 'uint16', writable: false },
            { id: 0x0001, name: 'VendorName', type: 'string', writable: false },
            { id: 0x0002, name: 'VendorID', type: 'vendor_id', writable: false },
            { id: 0x0003, name: 'ProductName', type: 'string', writable: false },
            { id: 0x0004, name: 'ProductID', type: 'uint16', writable: false },
            { id: 0x0005, name: 'NodeLabel', type: 'string', writable: true },
            { id: 0x0006, name: 'Location', type: 'string', writable: true },
            { id: 0x0007, name: 'HardwareVersion', type: 'uint16', writable: false },
            { id: 0x0008, name: 'HardwareVersionString', type: 'string', writable: false },
            { id: 0x0009, name: 'SoftwareVersion', type: 'uint32', writable: false },
            { id: 0x000A, name: 'SoftwareVersionString', type: 'string', writable: false },
            { id: 0x000B, name: 'ManufacturingDate', type: 'string', writable: false },
            { id: 0x000C, name: 'PartNumber', type: 'string', writable: false },
            { id: 0x000D, name: 'ProductURL', type: 'string', writable: false },
            { id: 0x000E, name: 'ProductLabel', type: 'string', writable: false },
            { id: 0x000F, name: 'SerialNumber', type: 'string', writable: false }
        ],
        commands: []
    },
    0x0300: {
        id: 0x0300,
        name: 'Color Control',
        attributes: [
            { id: 0x0000, name: 'CurrentHue', type: 'uint8', writable: false },
            { id: 0x0001, name: 'CurrentSaturation', type: 'uint8', writable: false },
            { id: 0x0003, name: 'CurrentX', type: 'uint16', writable: false },
            { id: 0x0004, name: 'CurrentY', type: 'uint16', writable: false },
            { id: 0x0007, name: 'ColorTemperatureMireds', type: 'uint16', writable: false },
            { id: 0x0008, name: 'ColorMode', type: 'enum8', writable: false },
            { id: 0x400A, name: 'ColorCapabilities', type: 'bitmap16', writable: false },
            { id: 0x400B, name: 'ColorTempPhysicalMinMireds', type: 'uint16', writable: false },
            { id: 0x400C, name: 'ColorTempPhysicalMaxMireds', type: 'uint16', writable: false }
        ],
        commands: [
            { id: 0x00, name: 'MoveToHue', args: ['Hue', 'Direction', 'TransitionTime', 'OptionsMask', 'OptionsOverride'] },
            { id: 0x01, name: 'MoveHue', args: ['MoveMode', 'Rate', 'OptionsMask', 'OptionsOverride'] },
            { id: 0x02, name: 'StepHue', args: ['StepMode', 'StepSize', 'TransitionTime', 'OptionsMask', 'OptionsOverride'] },
            { id: 0x03, name: 'MoveToSaturation', args: ['Saturation', 'TransitionTime', 'OptionsMask', 'OptionsOverride'] },
            { id: 0x04, name: 'MoveSaturation', args: ['MoveMode', 'Rate', 'OptionsMask', 'OptionsOverride'] },
            { id: 0x05, name: 'StepSaturation', args: ['StepMode', 'StepSize', 'TransitionTime', 'OptionsMask', 'OptionsOverride'] },
            { id: 0x06, name: 'MoveToHueAndSaturation', args: ['Hue', 'Saturation', 'TransitionTime', 'OptionsMask', 'OptionsOverride'] },
            { id: 0x07, name: 'MoveToColor', args: ['ColorX', 'ColorY', 'TransitionTime', 'OptionsMask', 'OptionsOverride'] },
            { id: 0x08, name: 'MoveColor', args: ['RateX', 'RateY', 'OptionsMask', 'OptionsOverride'] },
            { id: 0x09, name: 'StepColor', args: ['StepX', 'StepY', 'TransitionTime', 'OptionsMask', 'OptionsOverride'] },
            { id: 0x0A, name: 'MoveToColorTemperature', args: ['ColorTemperatureMireds', 'TransitionTime', 'OptionsMask', 'OptionsOverride'] }
        ]
    },
    0x0400: {
        id: 0x0400,
        name: 'Illuminance Measurement',
        attributes: [
            { id: 0x0000, name: 'MeasuredValue', type: 'uint16', writable: false },
            { id: 0x0001, name: 'MinMeasuredValue', type: 'uint16', writable: false },
            { id: 0x0002, name: 'MaxMeasuredValue', type: 'uint16', writable: false },
            { id: 0x0003, name: 'Tolerance', type: 'uint16', writable: false }
        ],
        commands: []
    },
    0x0402: {
        id: 0x0402,
        name: 'Temperature Measurement',
        attributes: [
            { id: 0x0000, name: 'MeasuredValue', type: 'int16', writable: false },
            { id: 0x0001, name: 'MinMeasuredValue', type: 'int16', writable: false },
            { id: 0x0002, name: 'MaxMeasuredValue', type: 'int16', writable: false },
            { id: 0x0003, name: 'Tolerance', type: 'uint16', writable: false }
        ],
        commands: []
    },
    0x0405: {
        id: 0x0405,
        name: 'Relative Humidity Measurement',
        attributes: [
            { id: 0x0000, name: 'MeasuredValue', type: 'uint16', writable: false },
            { id: 0x0001, name: 'MinMeasuredValue', type: 'uint16', writable: false },
            { id: 0x0002, name: 'MaxMeasuredValue', type: 'uint16', writable: false },
            { id: 0x0003, name: 'Tolerance', type: 'uint16', writable: false }
        ],
        commands: []
    },
    0x0406: {
        id: 0x0406,
        name: 'Occupancy Sensing',
        attributes: [
            { id: 0x0000, name: 'Occupancy', type: 'bitmap8', writable: false },
            { id: 0x0001, name: 'OccupancySensorType', type: 'enum8', writable: false },
            { id: 0x0002, name: 'OccupancySensorTypeBitmap', type: 'bitmap8', writable: false }
        ],
        commands: []
    }
};
