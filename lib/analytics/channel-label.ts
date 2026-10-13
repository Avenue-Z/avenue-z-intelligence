/** Display names for a verified paid-provider channel. This helper does not
 * classify referrers or UTM values, which may describe organic traffic.
 */
export function paidChannelLabel(value:string){
 const key=value.trim().toLowerCase().replace(/[\s-]+/g,'_');
 const names:Record<string,string>={meta:'Meta',meta_ads:'Meta',facebook:'Meta',facebook_ads:'Meta',fb:'Meta',instagram:'Meta',instagram_ads:'Meta',ig:'Meta',google:'Google',google_ads:'Google',googleads:'Google',tiktok:'TikTok',tik_tok:'TikTok',tiktok_ads:'TikTok',snapchat:'Snapchat',snapchat_ads:'Snapchat',applovin:'AppLovin'};
 return names[key]??value;
}
