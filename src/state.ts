/** 全局状态：当前选中的设备，所有页面共用 */
let _selectedSerial = "";
let _selectedLabel = "";

export function getSelectedSerial(): string {
  return _selectedSerial;
}

export function setSelectedSerial(serial: string): void {
  _selectedSerial = serial;
}

export function getSelectedLabel(): string {
  return _selectedLabel || _selectedSerial;
}

export function setSelectedLabel(label: string): void {
  _selectedLabel = label;
}
