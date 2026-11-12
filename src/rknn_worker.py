#!/usr/bin/env python3
"""RKNN Lite2 inference worker for Orange Pi 5 / RK3588.

Node.js sends one JSON line per frame:
  {"id": 1, "image": "<base64 jpeg>"}

The worker responds:
  {"type":"result","id":1,"latency":12.3,"boxes":[...]}
"""
import base64
import json
import sys
import time

import cv2
import numpy as np
from rknnlite.api import RKNNLite


MODEL_PATH = sys.argv[1]
INPUT_H = int(sys.argv[2])
INPUT_W = int(sys.argv[3])
CLASSES = json.loads(sys.argv[4])
CONF_THRES = float(sys.argv[5])
NMS_THRES = float(sys.argv[6])


def letterbox(image):
    height, width = image.shape[:2]
    scale = min(INPUT_W / width, INPUT_H / height)
    new_w = max(1, int(round(width * scale)))
    new_h = max(1, int(round(height * scale)))
    resized = cv2.resize(image, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
    canvas = np.full((INPUT_H, INPUT_W, 3), 114, dtype=np.uint8)
    pad_x = (INPUT_W - new_w) // 2
    pad_y = (INPUT_H - new_h) // 2
    canvas[pad_y:pad_y + new_h, pad_x:pad_x + new_w] = resized
    return canvas, scale, pad_x, pad_y


def flatten_outputs(outputs):
    rows = []
    for output in outputs:
        arr = np.asarray(output)
        arr = np.squeeze(arr)
        if arr.ndim == 1:
            arr = arr.reshape(1, -1)
        if arr.ndim == 2:
            if arr.shape[0] <= 512 and arr.shape[1] > arr.shape[0]:
                arr = arr.T
            rows.append(arr)
        elif arr.ndim == 3:
            # (C,H,W) -> (H,W,C), then flatten
            if arr.shape[0] <= 512 and arr.shape[1] != arr.shape[0]:
                arr = np.transpose(arr, (1, 2, 0))
            rows.append(arr.reshape(-1, arr.shape[-1]))
    if not rows:
        raise RuntimeError('RKNN output is empty')
    return np.concatenate(rows, axis=0)


def nms_per_class(boxes, scores, class_ids, iou_thres):
    keep_all = []
    for cls in np.unique(class_ids):
        idx = np.where(class_ids == cls)[0]
        order = idx[np.argsort(scores[idx])[::-1]]
        while order.size > 0:
            i = int(order[0])
            keep_all.append(i)
            if order.size == 1:
                break
            rest = order[1:]
            xx1 = np.maximum(boxes[i, 0], boxes[rest, 0])
            yy1 = np.maximum(boxes[i, 1], boxes[rest, 1])
            xx2 = np.minimum(boxes[i, 2], boxes[rest, 2])
            yy2 = np.minimum(boxes[i, 3], boxes[rest, 3])
            w = np.maximum(0.0, xx2 - xx1)
            h = np.maximum(0.0, yy2 - yy1)
            inter = w * h
            area_i = (boxes[i, 2] - boxes[i, 0]) * (boxes[i, 3] - boxes[i, 1])
            area_r = (boxes[rest, 2] - boxes[rest, 0]) * (boxes[rest, 3] - boxes[rest, 1])
            iou = inter / np.maximum(1e-9, area_i + area_r - inter)
            order = rest[iou <= iou_thres]
    return keep_all


def postprocess(outputs, scale, pad_x, pad_y, orig_w, orig_h):
    pred = flatten_outputs(outputs)
    if pred.shape[1] < 5:
        return []

    num_classes = len(CLASSES)
    has_obj = pred.shape[1] == num_classes + 5
    if has_obj:
        objectness = pred[:, 4:5]
        class_scores = pred[:, 5:5 + num_classes]
        scores_all = class_scores * objectness
    else:
        class_scores = pred[:, 4:4 + num_classes]
        scores_all = class_scores

    # Ultralytics RKNN export usually already applies sigmoid.
    if scores_all.size and (scores_all.min() < 0.0 or scores_all.max() > 1.0):
        scores_all = 1.0 / (1.0 + np.exp(-scores_all))

    class_ids = np.argmax(scores_all, axis=1)
    scores = scores_all[np.arange(scores_all.shape[0]), class_ids]
    mask = scores >= CONF_THRES
    if not np.any(mask):
        return []

    pred = pred[mask]
    scores = scores[mask]
    class_ids = class_ids[mask]

    cx, cy, w, h = pred[:, 0], pred[:, 1], pred[:, 2], pred[:, 3]
    x1 = (cx - w / 2.0 - pad_x) / scale
    y1 = (cy - h / 2.0 - pad_y) / scale
    x2 = (cx + w / 2.0 - pad_x) / scale
    y2 = (cy + h / 2.0 - pad_y) / scale
    boxes = np.stack([x1, y1, x2, y2], axis=1)
    boxes[:, [0, 2]] = np.clip(boxes[:, [0, 2]], 0, orig_w)
    boxes[:, [1, 3]] = np.clip(boxes[:, [1, 3]], 0, orig_h)

    keep = nms_per_class(boxes, scores, class_ids, NMS_THRES)
    result = []
    for i in keep[:50]:
        b = boxes[i]
        cls = int(class_ids[i])
        result.append({
            'x': float(b[0]),
            'y': float(b[1]),
            'w': float(max(1.0, b[2] - b[0])),
            'h': float(max(1.0, b[3] - b[1])),
            'classIndex': cls,
            'label': CLASSES[cls] if cls < len(CLASSES) else f'class_{cls}',
            'confidence': float(scores[i]),
        })
    result.sort(key=lambda item: item['confidence'], reverse=True)
    return result


def main():
    rknn = RKNNLite(verbose=False)
    ret = rknn.load_rknn(MODEL_PATH)
    if ret != 0:
        print(json.dumps({'type': 'error', 'error': f'load_rknn failed: {ret}'}), flush=True)
        return 1

    try:
        ret = rknn.init_runtime(core_mask=RKNNLite.NPU_CORE_0_1_2)
    except Exception:
        ret = rknn.init_runtime()
    if ret != 0:
        print(json.dumps({'type': 'error', 'error': f'init_runtime failed: {ret}'}), flush=True)
        return 1

    print(json.dumps({'type': 'ready', 'backend': 'RKNN NPU (RK3588)'}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get('id')
            raw = base64.b64decode(req['image'])
            image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
            if image is None:
                raise RuntimeError('cv2.imdecode failed')
            orig_h, orig_w = image.shape[:2]
            canvas, scale, pad_x, pad_y = letterbox(image)
            rgb = cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB)
            started = time.perf_counter()
            outputs = rknn.inference(inputs=[rgb])
            latency = (time.perf_counter() - started) * 1000.0
            boxes = postprocess(outputs, scale, pad_x, pad_y, orig_w, orig_h)
            print(json.dumps({
                'type': 'result', 'id': req_id,
                'latency': latency, 'boxes': boxes
            }, ensure_ascii=False), flush=True)
        except Exception as exc:
            print(json.dumps({
                'type': 'error', 'id': req_id, 'error': str(exc)
            }, ensure_ascii=False), flush=True)

    rknn.release()
    return 0


if __name__ == '__main__':
    sys.exit(main())
