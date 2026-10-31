import type { ProcessableMessage } from '@a2ui/web_core/v0_9';
import type { ElementDetails } from './types';

export const ELEMENT_CATALOG_ID = 'athena:element-editor:v1';
export const ELEMENT_SURFACE_ID = 'element-editor';
export const controlProperties = {
  color: { label: '文字颜色', type: 'ColorPicker' },
  'background-color': { label: '背景颜色', type: 'ColorPicker' },
  'border-color': { label: '边框颜色', type: 'ColorPicker' },
  'font-size': { label: '字号', type: 'Slider', min: 1, max: 160, step: 1, unit: 'px' },
  'font-weight': { label: '字重', type: 'Slider', min: 100, max: 900, step: 100, unit: '' },
  'border-radius': { label: '圆角', type: 'Slider', min: 0, max: 200, step: 1, unit: 'px' },
  'border-width': { label: '边框宽度', type: 'Slider', min: 0, max: 24, step: 1, unit: 'px' },
  padding: { label: '内边距', type: 'Slider', min: 0, max: 160, step: 1, unit: 'px' },
  'padding-top': { label: '上内边距', type: 'Slider', min: 0, max: 160, step: 1, unit: 'px' },
  'padding-right': { label: '右内边距', type: 'Slider', min: 0, max: 160, step: 1, unit: 'px' },
  'padding-bottom': { label: '下内边距', type: 'Slider', min: 0, max: 160, step: 1, unit: 'px' },
  'padding-left': { label: '左内边距', type: 'Slider', min: 0, max: 160, step: 1, unit: 'px' },
  'margin-top': { label: '上外边距', type: 'Slider', min: -160, max: 160, step: 1, unit: 'px' },
  'margin-right': { label: '右外边距', type: 'Slider', min: -160, max: 160, step: 1, unit: 'px' },
  'margin-bottom': { label: '下外边距', type: 'Slider', min: -160, max: 160, step: 1, unit: 'px' },
  'margin-left': { label: '左外边距', type: 'Slider', min: -160, max: 160, step: 1, unit: 'px' },
  'border-style': {
    label: '边框样式',
    type: 'ChoicePicker',
    options: ['none', 'solid', 'dashed', 'dotted', 'double'],
  },
  gap: { label: '间距', type: 'Slider', min: 0, max: 160, step: 1, unit: 'px' },
  width: { label: '宽度', type: 'Slider', min: 1, max: 2000, step: 1, unit: 'px' },
  height: { label: '高度', type: 'Slider', min: 1, max: 1600, step: 1, unit: 'px' },
  opacity: { label: '透明度', type: 'Slider', min: 0, max: 1, step: 0.01, unit: '' },
  'letter-spacing': { label: '字间距', type: 'Slider', min: -8, max: 24, step: 0.1, unit: 'px' },
  'text-align': {
    label: '文字对齐',
    type: 'ChoicePicker',
    options: ['left', 'center', 'right', 'justify'],
  },
  display: {
    label: '布局',
    type: 'ChoicePicker',
    options: ['block', 'inline-block', 'flex', 'grid', 'inline-flex'],
  },
  'flex-direction': {
    label: '排列方向',
    type: 'ChoicePicker',
    options: ['row', 'column', 'row-reverse', 'column-reverse'],
  },
  'align-items': {
    label: '交叉轴对齐',
    type: 'ChoicePicker',
    options: ['stretch', 'flex-start', 'center', 'flex-end', 'baseline'],
  },
  'justify-content': {
    label: '主轴对齐',
    type: 'ChoicePicker',
    options: ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly'],
  },
} as const;
export type ControlProperty = keyof typeof controlProperties;
export interface ElementControl {
  id: string;
  component: 'Slider' | 'ColorPicker' | 'ChoicePicker';
  property: ControlProperty;
  min?: number;
  max?: number;
  step?: number;
}
export interface ElementControlSurface {
  ref: string;
  revision: string;
  controls: ElementControl[];
}

/** Bound data before the renderer's Zod 3 parser, including collection and string sizes. */
export function validateElementControls(value: unknown): ElementControl[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 24)
    throw new Error('控件数量应为 1–24');
  const ids = new Set<string>();
  const properties = new Set<string>();
  return value.map((item) => {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      Object.keys(item).some(
        (key) => !['id', 'component', 'property', 'min', 'max', 'step'].includes(key),
      )
    )
      throw new Error('控件格式无效');
    const { id, component, property, min, max, step } = item;
    if (
      typeof id !== 'string' ||
      !/^[a-z][a-z0-9-]{0,39}$/.test(id) ||
      id === 'root' ||
      ids.has(id)
    )
      throw new Error('控件 ID 无效或重复');
    if (
      typeof property !== 'string' ||
      !Object.hasOwn(controlProperties, property) ||
      properties.has(property)
    )
      throw new Error('样式属性无效或重复');
    const spec = controlProperties[property as ControlProperty];
    if (component !== spec.type) throw new Error('控件与样式类型不匹配');
    ids.add(id);
    properties.add(property);
    if (spec.type === 'Slider') {
      const low = min ?? spec.min,
        high = max ?? spec.max,
        increment = step ?? spec.step;
      if (
        ![low, high, increment].every((n) => typeof n === 'number' && Number.isFinite(n)) ||
        low < spec.min ||
        high > spec.max ||
        high <= low ||
        increment <= 0 ||
        increment > high - low
      )
        throw new Error('滑块范围或步长无效');
      return {
        id,
        component,
        property: property as ControlProperty,
        min: low,
        max: high,
        step: increment,
      };
    }
    if (min !== undefined || max !== undefined || step !== undefined)
      throw new Error('该控件不接受数值范围');
    return { id, component, property: property as ControlProperty };
  });
}
export function defaultElementControls(element: ElementDetails): ElementControl[] {
  const layout = ['flex', 'inline-flex', 'grid'].includes(element.computed.display);
  const keys: ControlProperty[] = [
    'color',
    'background-color',
    'font-size',
    'border-radius',
    'padding',
    'opacity',
  ];
  if (layout) keys.push('gap', 'align-items', 'justify-content');
  else if (element.tag === 'img') keys.push('width', 'height');
  else keys.push('font-weight', 'text-align');
  return keys.map((property) => ({
    id: property,
    component: controlProperties[property].type,
    property,
  }));
}
export function controlData(
  element: ElementDetails,
  controls: ElementControl[],
): Record<string, string | number> {
  return Object.fromEntries(
    controls.map((control) => {
      const spec = controlProperties[control.property];
      const raw = element.computed[control.property] ?? '';
      return [
        control.property,
        spec.type === 'Slider'
          ? Number.isFinite(parseFloat(raw))
            ? parseFloat(raw)
            : spec.min
          : raw,
      ];
    }),
  );
}
function controlSection(property: ControlProperty) {
  if (['font-size', 'font-weight', 'letter-spacing', 'text-align', 'color'].includes(property))
    return 'type';
  if (
    [
      'background-color',
      'border-color',
      'border-radius',
      'border-width',
      'border-style',
      'opacity',
    ].includes(property)
  )
    return 'appearance';
  return 'layout';
}
export function elementControlMessages(
  element: ElementDetails,
  controls: ElementControl[],
): ProcessableMessage[] {
  const sections = [
    ['appearance', '外观'],
    ['type', '排版'],
    ['layout', '布局与间距'],
  ]
    .map(([key, label]) => ({
      id: '_' + key,
      component: 'Group',
      label,
      children: controls
        .filter((control) => controlSection(control.property) === key)
        .map((control) => control.id),
    }))
    .filter((section) => section.children.length);
  return [
    {
      version: 'v0.9.1',
      createSurface: { surfaceId: ELEMENT_SURFACE_ID, catalogId: ELEMENT_CATALOG_ID },
    },
    {
      version: 'v0.9.1',
      updateComponents: {
        surfaceId: ELEMENT_SURFACE_ID,
        components: [
          { id: 'root', component: 'Column', children: sections.map((section) => section.id) },
          ...sections,
          ...controls
            .map((control) => {
              const spec = controlProperties[control.property];
              return {
                ...spec,
                ...control,
                value: { path: '/' + control.property },
                type: undefined,
              };
            })
            .map(({ type, ...rest }) => rest),
        ],
      },
    },
    {
      version: 'v0.9.1',
      updateDataModel: { surfaceId: ELEMENT_SURFACE_ID, value: controlData(element, controls) },
    },
  ];
}
