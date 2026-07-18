#!/usr/bin/env python3
"""
逆向第一步：扫出玩具的 BLE 地址。

用法：
    1. 玩具开机，别开官方 App（App 占着连接你就扫不到），让它在广播态
    2. python scan.py
    3. 把玩具拿近再拿远，rssi（信号强度）跟着变大变小的那个就是它

Windows/Linux 扫到的是真实 MAC（大写、冒号分隔），填进 server.py 的 ADDR。
纯被动扫描——不连接、不写任何东西，绝对安全。
"""
import asyncio
from bleak import BleakScanner


async def main(timeout: int = 12):
    print(f"扫描中…… {timeout}s。把玩具拿近拿远，看哪个 rssi 跟着变。\n")
    found = await BleakScanner.discover(timeout=timeout, return_adv=True)

    rows = []
    for addr, (dev, adv) in found.items():
        rssi = adv.rssi if adv.rssi is not None else -999
        name = dev.name or adv.local_name or "(无名)"
        rows.append((rssi, addr, name, list(adv.service_uuids)))
    rows.sort(reverse=True)  # 信号强的排前面

    if not rows:
        print("没扫到设备。确认：①玩具开机了 ②没被官方 App 占着连接 ③离得够近。")
        return

    print(f"{'rssi':>5}  {'地址':<40}  名字")
    print("-" * 72)
    for rssi, addr, name, uuids in rows:
        print(f"{rssi:>5}  {addr:<40}  {name}")
        if uuids:
            print(f"        service_uuids: {uuids}")
    print("\n名字带 SOSEXY / YUTU、或者拿近 rssi 明显变大的那个就是目标。把地址记下来。")


if __name__ == "__main__":
    asyncio.run(main())
