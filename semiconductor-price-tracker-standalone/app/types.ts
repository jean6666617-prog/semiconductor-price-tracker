export type Status = "已更新" | "待更新" | "待确认" | "暂无来源";
export type Item = {
  id: number;
  group: string;
  name: string;
  spec: string;
  supplier: string;
  mpn: string;
  price: string;
  unit: string;
  source: string;
  url: string;
  status: Status;
  updated: string;
  cadence: string;
};
