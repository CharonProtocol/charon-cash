export const vertex = `
  varying vec2 vUv;
  varying vec3 vWorld;
  void main() {
    vUv = uv;
    vec4 p = modelMatrix * vec4(position, 1.0);
    vWorld = p.xyz;
    gl_Position = projectionMatrix * viewMatrix * p;
  }
`;
const common = `
  uniform vec2 resolution;
  uniform vec2 lantern;
  uniform float radius;
  varying vec2 vUv;
  varying vec3 vWorld;
  float privacy(vec2 p) {
    return (1.0 - smoothstep(radius-30.0, radius+30.0, distance(p,lantern))) * step(0.0,radius);
  }
  vec3 backdrop(vec2 uv, float dark) {
    float sweep = exp(-pow((uv.x*.70 + uv.y*.58 - .57)*2.4,2.0));
    float cloud = .5+.5*sin(uv.x*6.5 + uv.y*3.0);
    vec3 ivory = mix(vec3(.984,.973,.953),vec3(.956,.916,.861),sweep*.43);
    ivory += cloud*.006;
    float d = smoothstep(-.05,1.12,uv.x*.61 + (1.0-uv.y)*.39);
    vec3 charcoal = mix(vec3(.047,.051,.059),vec3(.294,.310,.333),d);
    charcoal += .025*exp(-pow((uv.x-uv.y-.03)*2.3,2.0));
    return mix(ivory,charcoal,dark);
  }
`;
export const backgroundFragment = common + `
  void main() {
    vec2 uv=gl_FragCoord.xy/resolution;
    gl_FragColor=vec4(backdrop(uv,privacy(vWorld.xy)),1.0);
  }
`;
export const cardFragment = common + `
  uniform sampler2D publicText;
  uniform sampler2D privateText;
  uniform float opacity;
  uniform float hover;
  float box(vec2 p,vec2 b,float r) {
    vec2 q=abs(p)-b+r;
    return min(max(q.x,q.y),0.0)+length(max(q,0.0))-r;
  }
  void main() {
    vec2 p=(vUv-.5)*vec2(800.0,238.0);
    float sd=box(p,vec2(360.0,79.0),19.0);
    float aa=max(fwidth(sd),.45);
    float inside=1.0-smoothstep(-aa,aa,sd);
    float dark=privacy(vWorld.xy);
    // Soft shadow lives outside the contour; no opaque rectangular plane.
    float shadowDistance=box(p-vec2(0.0,-9.0),vec2(356.0,76.0),21.0);
    float shadow=exp(-max(shadowDistance,0.0)/10.5)*mix(.085,.20,dark)*(1.0-inside);
    vec2 uv=gl_FragCoord.xy/resolution;
    float edge=exp(-abs(sd)/2.0);
    vec2 direction=normalize(p+vec2(.001));
    vec3 glass=backdrop(uv+direction*edge*.009,dark);
    glass=mix(glass,vec3(1.0),mix(.24,.065,dark));
    float top=clamp((p.y+79.0)/158.0,0.0,1.0);
    glass += mix(.013,.019,dark)*top + hover*.016;
    float lightDirection=.38+.62*pow(abs(dot(direction,normalize(vec2(-.7,1.0)))),4.0);
    float rim=exp(-abs(sd+1.15)/1.05)*lightDirection;
    glass=mix(glass,vec3(1.0),rim*mix(.94,.68,dark));
    float inner=exp(-abs(sd+3.2)/1.6);
    glass+=inner*mix(.005,.018,dark);
    vec2 textUv=(p+vec2(360.0,79.0))/vec2(720.0,158.0);
    vec4 ink=mix(texture2D(publicText,textUv),texture2D(privateText,textUv),dark);
    glass=mix(glass,ink.rgb,ink.a);
    float alpha=inside+shadow*(1.0-inside);
    gl_FragColor=vec4(glass*inside/max(alpha,.0001),alpha*opacity);
  }
`;
