import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ColorArea, ColorSlider, ColorField, Input, Label, ListBox } from '@heroui/react';
import { CellSlider, CellColorPicker, CellSelect } from '@heroui-pro/react';
import {
  A2uiSurface,
  createComponentImplementation,
  type ReactCatalogComponent,
} from '@a2ui/react/v0_9';
import { Catalog, CommonSchemas, MessageProcessor } from '@a2ui/web_core/v0_9';
import { z } from 'zod';
import {
  controlProperties,
  controlData,
  defaultElementControls,
  elementControlMessages,
  ELEMENT_CATALOG_ID,
  ELEMENT_SURFACE_ID,
  type ElementControlSurface,
} from '../shared/element-controls';
import type { ElementDetails, ElementEditResult } from '../shared/types';
import { LiveStyleQueue } from './LiveStyleQueue';

const Editing = createContext<{
  preview: (property: string, value: string) => void;
  finish: () => void;
}>({ preview() {}, finish() {} });
const propertySchema = z.enum(
  Object.keys(controlProperties) as [
    keyof typeof controlProperties,
    ...(keyof typeof controlProperties)[],
  ],
);
const common = { label: z.string().max(40), property: propertySchema };
const Column = createComponentImplementation(
  { name: 'Column', schema: z.object({ children: CommonSchemas.ChildList }).strict() },
  ({ props, buildChild }) => (
    <div className="live-control-sections">
      {(props.children as string[]).map((id) => (
        <div key={id}>{buildChild(id)}</div>
      ))}
    </div>
  ),
);
const Group = createComponentImplementation(
  {
    name: 'Group',
    schema: z.object({ label: z.string().max(40), children: CommonSchemas.ChildList }).strict(),
  },
  ({ props, buildChild }) => (
    <section className="live-control-group" aria-label={props.label}>
      <h3>{props.label}</h3>
      <div className="live-control-grid">
        {(props.children as string[]).map((id) => (
          <div key={id}>{buildChild(id)}</div>
        ))}
      </div>
    </section>
  ),
);
const Slider = createComponentImplementation(
  {
    name: 'Slider',
    schema: z
      .object({
        ...common,
        value: CommonSchemas.DynamicNumber,
        min: z.number(),
        max: z.number(),
        step: z.number(),
        unit: z.enum(['px', '']),
      })
      .strict(),
  },
  ({ props }) => {
    const editing = useContext(Editing);
    const change = (value: number) => {
      if (!Number.isFinite(value) || value < props.min || value > props.max) return;
      props.setValue(value);
      editing.preview(props.property, `${value}${props.unit}`);
    };
    return (
      <div className="live-control live-slider">
        <CellSlider
          aria-label={props.label + '滑块'}
          value={props.value ?? props.min}
          minValue={props.min}
          maxValue={props.max}
          step={props.step}
          onChange={(value) => change(value as number)}
          onChangeEnd={editing.finish}
        >
          <CellSlider.Track>
            <CellSlider.Fill />
            <CellSlider.Thumb />
            <CellSlider.Label>{props.label}</CellSlider.Label>
          </CellSlider.Track>
        </CellSlider>
        <div className="live-number">
          <Input
            aria-label={props.label + '数值'}
            type="number"
            min={props.min}
            max={props.max}
            step={props.step}
            value={props.value ?? props.min}
            onChange={(e) => {
              if (e.target.value !== '') change(Number(e.target.value));
            }}
            onBlur={editing.finish}
          />
          <small>{props.unit}</small>
        </div>
      </div>
    );
  },
);
function colorHex(value: string) {
  if (/^#[a-f0-9]{6}$/i.test(value)) return value;
  const rgb = value.match(/^rgba?\(\s*(\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)/);
  return rgb
    ? '#' +
        rgb
          .slice(1, 4)
          .map((n) => Number(n).toString(16).padStart(2, '0'))
          .join('')
    : '#000000';
}
const ColorPicker = createComponentImplementation(
  {
    name: 'ColorPicker',
    schema: z.object({ ...common, value: CommonSchemas.DynamicString }).strict(),
  },
  ({ props }) => {
    const editing = useContext(Editing);
    const [draft, setDraft] = useState(props.value ?? '');
    useEffect(() => setDraft(props.value ?? ''), [props.value]);
    const change = (value: string) => {
      props.setValue(value);
      editing.preview(props.property, value);
    };
    return (
      <div className="live-control live-color">
        <CellColorPicker
          aria-label={props.label + '选择器'}
          value={colorHex(props.value ?? '')}
          onChange={(color) => change(color.toString('hex'))}
        >
          <CellColorPicker.Trigger aria-label={props.label + '选择器'}>
            <CellColorPicker.Label>{props.label}</CellColorPicker.Label>
            <CellColorPicker.Swatch />
          </CellColorPicker.Trigger>
          <CellColorPicker.Popover
            className="color-popover"
            onOpenChange={(open) => {
              if (!open) editing.finish();
            }}
          >
            <ColorArea
              aria-label="饱和度和亮度"
              onChangeEnd={editing.finish}
              colorSpace="hsb"
              xChannel="saturation"
              yChannel="brightness"
            >
              <ColorArea.Thumb />
            </ColorArea>
            <ColorSlider
              aria-label="色相"
              onChangeEnd={editing.finish}
              channel="hue"
              colorSpace="hsb"
            >
              <ColorSlider.Track>
                <ColorSlider.Thumb />
              </ColorSlider.Track>
            </ColorSlider>
            <ColorField
              aria-label="十六进制颜色"
              onChange={(color) => {
                if (!color) return;
                change(color.toString('hex'));
                editing.finish();
              }}
            >
              <ColorField.Group>
                <ColorField.Input />
              </ColorField.Group>
            </ColorField>
          </CellColorPicker.Popover>
        </CellColorPicker>
        <Input
          aria-label={props.label + '颜色值'}
          value={draft}
          maxLength={80}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft !== props.value) {
              change(draft);
              editing.finish();
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
        />
      </div>
    );
  },
);
const choiceLabels: Record<string, string> = {
  none: '无',
  solid: '实线',
  dashed: '虚线',
  dotted: '点线',
  double: '双线',
  left: '左对齐',
  center: '居中',
  right: '右对齐',
  justify: '两端对齐',
  block: '块级',
  'inline-block': '行内块',
  flex: '弹性布局',
  grid: '网格',
  'inline-flex': '行内弹性',
  row: '横向',
  column: '纵向',
  'row-reverse': '横向反转',
  'column-reverse': '纵向反转',
  stretch: '拉伸',
  'flex-start': '起点',
  'flex-end': '终点',
  baseline: '基线',
  'space-between': '两端分布',
  'space-around': '均匀环绕',
  'space-evenly': '等距分布',
};
const ChoicePicker = createComponentImplementation(
  {
    name: 'ChoicePicker',
    schema: z
      .object({
        ...common,
        value: CommonSchemas.DynamicString,
        options: z.array(z.string().max(40)).max(8),
      })
      .strict(),
  },
  ({ props }) => {
    const editing = useContext(Editing);
    return (
      <CellSelect
        className="live-control live-choice"
        aria-label={props.label}
        value={props.value ?? ''}
        onChange={(value) => {
          if (value === null) return;
          props.setValue(String(value));
          editing.preview(props.property, String(value));
          editing.finish();
        }}
      >
        <CellSelect.Trigger>
          <CellSelect.Label>{props.label}</CellSelect.Label>
          <CellSelect.Value />
          <CellSelect.Indicator />
        </CellSelect.Trigger>
        <CellSelect.Popover>
          <ListBox aria-label={props.label}>
            {!props.options.includes(props.value ?? '') && (
              <ListBox.Item id={props.value || '__current'} textValue={props.value || '当前值'}>
                <Label>{props.value || '当前值'}</Label>
                <ListBox.ItemIndicator />
              </ListBox.Item>
            )}
            {(props.options as string[]).map((value) => (
              <ListBox.Item key={value} id={value} textValue={choiceLabels[value] || value}>
                <Label>{choiceLabels[value] || value}</Label>
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </CellSelect.Popover>
      </CellSelect>
    );
  },
);
const catalog = new Catalog(
  ELEMENT_CATALOG_ID,
  'v0.9.1',
  [Column, Group, Slider, ColorPicker, ChoicePicker],
  [],
);

export default function ElementControls({
  element,
  surface,
  onAction,
  onCommit,
}: {
  element: ElementDetails;
  surface?: ElementControlSurface;
  onAction: <T>(name: string, payload: unknown) => Promise<T>;
  onCommit: (result: ElementEditResult) => void;
}) {
  const [status, setStatus] = useState('');
  const callbacks = useRef({ onAction, onCommit });
  callbacks.current = { onAction, onCommit };
  const controls = useMemo(
    () => surface?.controls ?? defaultElementControls(element),
    [element.ref, surface?.revision],
  );
  const processor = useMemo(() => {
    const processor = new MessageProcessor<ReactCatalogComponent>([catalog], undefined, {
      version: 'v0.9.1',
    });
    processor.processMessages(elementControlMessages(element, controls));
    return processor;
  }, [element.ref, controls]);
  const model = processor.model.surfacesMap.get(ELEMENT_SURFACE_ID)!;
  const queue = useMemo(
    () =>
      new LiveStyleQueue(
        element.ref,
        (name, payload) => callbacks.current.onAction(name, payload),
        (result) => {
          callbacks.current.onCommit(result);
          setStatus('已预览，可撤销');
        },
        setStatus,
      ),
    [element.ref, controls],
  );
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (!queue.busy)
        processor.processMessages([
          {
            version: 'v0.9.1',
            updateDataModel: {
              surfaceId: ELEMENT_SURFACE_ID,
              value: controlData(element, controls),
            },
          },
        ]);
    });
    return () => cancelAnimationFrame(frame);
  }, [element, queue, processor, controls]);
  useEffect(
    () => () => {
      queue.dispose();
      processor.dispose();
    },
    [queue, processor],
  );
  return (
    <Editing.Provider
      value={{
        preview: (property, value) => {
          setStatus('');
          queue.enqueue(property, value);
        },
        finish: () => {
          void queue.finish();
        },
      }}
    >
      <div className="element-live-controls">
        <A2uiSurface surface={model} />
        <p className="inspector-note" role="status">
          {status}
        </p>
      </div>
    </Editing.Provider>
  );
}
