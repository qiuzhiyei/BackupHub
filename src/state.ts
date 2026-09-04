/** 全局状态：当前选中的设备序列号，所有页面共用 */
let _selectedSerial = "";

export function getSelectedSerial(): string {
  return _selectedSerial;
}

export function setSelectedSerial(serial: string): void {
  _selectedSerial = serial;
}
