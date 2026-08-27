export interface ChartData {
  timestamp: string;
  electric: number;
  water: number;
  ac: number;
}

export interface ChartRequest {
  /** Serializable Chart.js configuration (functions stripped) */
  config: unknown;
  title: string;
  width: number;
  height: number;
}

interface DatasetConfig {
  label: string;
  data: { x: number; y: number }[];
  borderColor: string;
  backgroundColor: string;
}

const DATASET_CONFIGS: DatasetConfig[] = [
  {
    label: '电费 (¥)',
    data: [],
    borderColor: 'rgb(255, 99, 132)',
    backgroundColor: 'rgba(255, 99, 132, 0.1)'
  },
  {
    label: '水费 (¥)',
    data: [],
    borderColor: 'rgb(54, 162, 235)',
    backgroundColor: 'rgba(54, 162, 235, 0.1)'
  },
  {
    label: '空调费 (¥)',
    data: [],
    borderColor: 'rgb(75, 192, 192)',
    backgroundColor: 'rgba(75, 192, 192, 0.1)'
  }
];

const FONT_FAMILY = "'Sora', 'Microsoft YaHei', sans-serif";

/**
 * Build serializable Chart.js configurations for billing data.
 * Rendering to PNG is performed by an offscreen Chromium window
 * in the Electron main process (replacing upstream's node-canvas).
 *
 * Automatically splits positive and negative values into separate charts.
 * Returns an array of chart requests (0, 1 or 2 items).
 */
export const buildBillingChartRequests = (
  data: ChartData[],
  room: string,
  lines: string = 'ewa'
): ChartRequest[] => {
  if (data.length < 2) {
    return [];
  }

  // Sort data by timestamp
  const sorted = [...data].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  // Convert data to {x, y} format with timestamps in milliseconds for proper time scaling
  const electricData = sorted.map((d) => ({ x: new Date(d.timestamp).getTime(), y: d.electric }));
  const waterData = sorted.map((d) => ({ x: new Date(d.timestamp).getTime(), y: d.water }));
  const acData = sorted.map((d) => ({ x: new Date(d.timestamp).getTime(), y: d.ac }));

  // Determine which items have any values <= -10
  const hasNegativeElectric = sorted.some((d) => d.electric <= -10);
  const hasNegativeWater = sorted.some((d) => d.water <= -10);
  const hasNegativeAc = sorted.some((d) => d.ac <= -10);

  // Determine which lines to show
  const showElectric = lines.toLowerCase().includes('e');
  const showWater = lines.toLowerCase().includes('w');
  const showAc = lines.toLowerCase().includes('a');

  // Separate datasets into positive and negative groups
  const positiveDatasets: DatasetConfig[] = [];
  const negativeDatasets: DatasetConfig[] = [];

  const allData = [
    { data: electricData, hasNegative: hasNegativeElectric, index: 0, show: showElectric },
    { data: waterData, hasNegative: hasNegativeWater, index: 1, show: showWater },
    { data: acData, hasNegative: hasNegativeAc, index: 2, show: showAc }
  ];

  for (const { data: itemData, hasNegative, index, show } of allData) {
    if (!show) continue;

    const isAllZero = itemData.every((point) => point.y === 0);
    if (isAllZero) {
      continue;
    }

    const config = { ...DATASET_CONFIGS[index], data: itemData };
    if (hasNegative) {
      negativeDatasets.push(config);
    } else {
      config.data = itemData.map((point) => ({ x: point.x, y: Math.max(point.y, 0) }));
      positiveDatasets.push(config);
    }
  }

  // Create chart requests
  const results: ChartRequest[] = [];

  if (positiveDatasets.length > 0) {
    const title = `${room} 余额账单`;
    results.push({
      config: createChartConfig(positiveDatasets, title, sorted.length),
      title,
      width: 800,
      height: 500
    });
  }

  if (negativeDatasets.length > 0) {
    const title = `${room} 欠费账单`;
    results.push({
      config: createChartConfig(negativeDatasets, title, sorted.length),
      title,
      width: 800,
      height: 500
    });
  }

  return results;
};

/**
 * Create a serializable chart configuration with category time scale.
 * The x axis carries precomputed labels; the renderer attaches the
 * tick callback that thins them out (functions can't cross IPC).
 */
const createChartConfig = (
  datasets: DatasetConfig[],
  title: string,
  totalPoints: number
): unknown => {
  let hourInterval: number;
  if (totalPoints < 48) {
    hourInterval = 1;
  } else if (totalPoints < 72) {
    hourInterval = 2;
  } else if (totalPoints < 96) {
    hourInterval = 4;
  } else if (totalPoints < 144) {
    hourInterval = 6;
  } else {
    hourInterval = 8;
  }

  // Use the first dataset's timestamps as axis labels (all datasets share x values)
  const timestamps = datasets[0].data.map((p) => p.x);
  const labels = timestamps.map((ts) => {
    const date = new Date(ts);
    const dateLabel = date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
    const timeLabel = `${date.getHours().toString().padStart(2, '0')}:${date
      .getMinutes()
      .toString()
      .padStart(2, '0')}`;
    return date.getHours() === 0 ? dateLabel : timeLabel;
  });

  const fontSpec = { family: FONT_FAMILY };

  return {
    type: 'line',
    data: {
      labels,
      datasets: datasets.map((ds) => ({
        label: ds.label,
        data: ds.data.map((p) => p.y),
        borderColor: ds.borderColor,
        backgroundColor: ds.backgroundColor,
        borderWidth: 2.5,
        cubicInterpolationMode: 'monotone',
        fill: true,
        pointRadius: totalPoints < 24 ? 4 : 0
      }))
    },
    options: {
      devicePixelRatio: 2,
      responsive: false,
      animation: false,
      font: fontSpec,
      plugins: {
        title: {
          display: true,
          text: title,
          font: { size: 18, weight: 'bold', family: FONT_FAMILY }
        },
        legend: {
          display: true,
          position: 'top',
          labels: { font: fontSpec }
        }
      },
      scales: {
        y: {
          beginAtZero: false,
          title: { display: true, text: '余额 (¥)', font: fontSpec },
          ticks: { font: fontSpec }
        },
        x: {
          title: { display: true, text: '时间', font: fontSpec },
          ticks: {
            maxRotation: 45,
            minRotation: 0,
            autoSkip: true,
            maxTicksLimit: Math.max(8, Math.floor(24 / hourInterval) * 2),
            font: fontSpec
          }
        }
      }
    },
    plugins: [
      {
        id: 'customCanvasBackgroundColor'
        // Renderer registers a global beforeDraw that fills white
      }
    ]
  };
};

/**
 * Generate billing summary with current values and 24h changes
 */
export const generateBillingSummary = (
  current: { electric: number; water: number; ac: number },
  change24h?: { electric: number; water: number; ac: number } | null
): string => {
  let output = '📊 当前余额\n';
  output += '─'.repeat(15) + '\n';
  output += `⚡ 电费：\t${current.electric.toFixed(2)} 元\n`;
  output += `💧 水费：\t${current.water.toFixed(2)} 元\n`;
  output += `❄️ 空调费：\t${current.ac.toFixed(2)} 元\n`;

  if (change24h) {
    output += '\n📈 最近 24 小时\n';
    output += '─'.repeat(15) + '\n';
    output += `⚡ 电费：\t${change24h.electric > 0 ? '+' : ''}${change24h.electric.toFixed(2)} 元\n`;
    output += `💧 水费：\t${change24h.water > 0 ? '+' : ''}${change24h.water.toFixed(2)} 元\n`;
    output += `❄️ 空调费：\t${change24h.ac > 0 ? '+' : ''}${change24h.ac.toFixed(2)} 元\n\n`;
  }

  return output;
};
