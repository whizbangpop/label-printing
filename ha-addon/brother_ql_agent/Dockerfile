ARG BUILD_FROM
FROM ${BUILD_FROM}

# Pillow and pyusb come from Alpine packages so nothing needs compiling on the Pi.
RUN apk add --no-cache python3 py3-pip py3-pillow py3-usb py3-setuptools libusb

COPY requirements.txt /tmp/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r /tmp/requirements.txt \
 && rm /tmp/requirements.txt

COPY agent /app
WORKDIR /app
CMD ["python3", "-u", "/app/main.py"]
