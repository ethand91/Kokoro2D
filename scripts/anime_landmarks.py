"""One-shot local inference worker; PNG on stdin, landmark JSON on stdout."""
import contextlib
import json
import sys


def detect(payload):
    # Keep model/library diagnostics out of the JSON protocol.
    with contextlib.redirect_stdout(sys.stderr):
        import cv2
        import numpy as np
        import torch
        from anime_face_detector import create_detector

        torch.set_num_threads(4)
        image = cv2.imdecode(np.frombuffer(payload, dtype=np.uint8), cv2.IMREAD_COLOR)
        if image is None or max(image.shape[:2]) > 1400:
            raise ValueError("Expected an image with sides no larger than 1400 pixels.")
        detector = create_detector("yolov3", device="cpu")
        predictions = detector(image)
    return {
        "width": image.shape[1], "height": image.shape[0],
        "faces": [{"bbox": p["bbox"].tolist(), "keypoints": p["keypoints"].tolist()}
                  for p in predictions],
    }


if __name__ == "__main__":
    try:
        print(json.dumps(detect(sys.stdin.buffer.read()), allow_nan=False))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
